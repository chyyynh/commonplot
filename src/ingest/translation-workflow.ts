import { createResourceTask, enqueueSearchProgress, type ResourceTask, type ResourceTaskContext } from './progress';
import { canonicalizeResourceLang } from './resource-language';
// Durable translation execution; resource processing only enqueues this Workflow.
import { generateText, Output } from 'ai';
import { type WorkflowDynamicDelayContext, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { sha256Hex } from '../shared/hash';
import { coreGatewayOptions, CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';
import {
	compileMarkdownTranslationArtifact,
	type MarkdownSegmentTranslation,
	type MarkdownTranslationBatch,
	MarkdownTranslationInvariantError,
	planMarkdownTranslation,
} from './markdown-translation';
import { isMarkdownTranslationFormatError, splitSegmentsInHalf, translateMarkdownBatchToZhHant } from './markdown-translation-model';
import { PDF_MIME } from './platforms/pdf-policy';
import { type ResourceTranslationCandidate, shouldEnqueueResourceTranslation } from './translation-policy';

type ResourceTranslationPayload = { force?: boolean; resourceId: string; translationRevision: string };
const ResourceTranslationSourceSchema = z.enum(['original', 'machine', 'human']);

type ResourceTranslationInput = ResourceTranslationCandidate & {
	id: string;
	title: string;
	summary: string | null;
	content: string;
	zhHantTranslation: {
		aligned: boolean;
		title: string | null;
		summary: string | null;
		content: string | null;
		source: z.infer<typeof ResourceTranslationSourceSchema>;
	} | null;
};

type ResourceTranslationInputRow = {
	file_type: string | null;
	id: string;
	kind: ResourceTranslationCandidate['kind'];
	resource_platform: ResourceTranslationCandidate['resourcePlatform'];
	original_lang: string;
	scope: 'corpus' | 'private';
	title: string | null;
	summary: string | null;
	content: string | null;
	zh_hant_title: string | null;
	zh_hant_summary: string | null;
	zh_hant_content: string | null;
	zh_hant_alignment_version: string | null;
	zh_hant_source: string | null;
	translation_revision: string;
	url: string | null;
};

const PARTIAL_CONTENT_TRANSLATION_RATIO = 0.2;
const MIN_TRANSLATABLE_TEXT_LENGTH = 20;
const MARKDOWN_TRANSLATION_CONCURRENCY = 15;
const AI_RATE_LIMIT_ERROR = /\b(?:3021|3040|429)\b|rate limit|too many requests|capacity temporarily exceeded/iu;

function translationRetryDelay({ ctx, error }: WorkflowDynamicDelayContext): number {
	// The provider's RPM window is one minute. Short exponential retries all land inside the same exhausted window,
	// especially when a source cron starts several translations together. Waiting durably costs no active Worker time.
	if (AI_RATE_LIMIT_ERROR.test(error.message)) return ctx.attempt * 60_000;
	return ctx.attempt * 15_000;
}

function privateUploadedPdfTranslationSqlAdmission() {
	return sql`(
		resource.scope = 'private'
		AND resource.kind = 'file'
		AND resource.resource_platform IS NULL
		AND resource.file_type = ${PDF_MIME}
		AND resource.storage_key IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM user_files file
			WHERE file.resource_id = resource.id
		)
	)`;
}

type ZhHantTranslationPlan = { metadata: boolean; content: boolean };
const MetadataTranslationSchema = z.object({ title: z.string().trim().min(1), summary: z.string().trim().min(1) });

type MachineZhHantTranslationPatch = Partial<
	z.infer<typeof MetadataTranslationSchema> & NonNullable<Awaited<ReturnType<typeof translatePlannedContent>>>
>;

function isBlank(value: string | null | undefined): boolean {
	return !value?.trim();
}

function hasTranslatableContent(content: string): boolean {
	const text = content
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, '');
	return text.length >= MIN_TRANSLATABLE_TEXT_LENGTH;
}

function needsMachineContentTranslation(resource: ResourceTranslationInput): boolean {
	if (resource.kind === 'paper' && resource.zhHantTranslation?.source === 'machine' && !resource.zhHantTranslation.aligned) return true;
	const translated = resource.zhHantTranslation?.content?.trim();
	if (!translated) return true;
	const content = resource.content.trim();
	return content.length >= 1000 && translated.length / content.length < PARTIAL_CONTENT_TRANSLATION_RATIO;
}

function planZhHantTranslation(resource: ResourceTranslationInput, force: boolean): ZhHantTranslationPlan {
	const translation = resource.zhHantTranslation;
	if (
		!shouldEnqueueResourceTranslation(resource) ||
		isBlank(resource.title) ||
		isBlank(resource.content) ||
		translation?.source === 'human'
	) {
		return { metadata: false, content: false };
	}

	return {
		metadata: force || isBlank(translation?.title) || (!isBlank(resource.summary) && isBlank(translation?.summary)),
		content: hasTranslatableContent(resource.content) && (force || needsMachineContentTranslation(resource)),
	};
}

/** Translate persisted metadata only; missing summaries are resolved during original enrichment. */
async function translateResourceMetadata(resource: ResourceTranslationInput, env: CoreEnv) {
	const summary = resource.summary?.trim();
	const { finishReason, output } = await generateText({
		model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
			...CORE_STRUCTURED_MODEL_SETTINGS,
			...coreGatewayOptions(env, { feature: 'resource-metadata-localization', resource_id: resource.id }),
		}),
		system: `Translate the supplied resource metadata into natural Taiwan Traditional Chinese (zh-Hant).
Translate the title faithfully.
${summary ? 'Translate the supplied summary in full. Preserve its length and meaning; do not summarize it again.' : 'Translate only the title. No source summary is available; do not create one.'}
Preserve attribution, tone, technical terminology, qualifications, and uncertainty. Do not add information.
For papers, preserve the academic claims and limitations of the supplied abstract or summary.
Use Taiwan vocabulary and punctuation. Return only the requested schema fields as plain text without Markdown.`,
		prompt: `Original language: ${resource.originalLang}
Resource kind: ${resource.kind}
Title: ${resource.title}${summary ? `\nSummary: ${summary}` : ''}`,
		output: Output.object({
			name: 'resource_translation_metadata',
			description: 'Faithful Taiwan Traditional Chinese localization of the supplied resource metadata.',
			schema: summary ? MetadataTranslationSchema : MetadataTranslationSchema.pick({ title: true }),
		}),
		maxOutputTokens: summary ? 2400 : 500,
		temperature: 0.3,
		reasoning: 'none',
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource metadata localization hit its output token cap');
	return output;
}

async function translateDurableBatch(
	batch: MarkdownTranslationBatch,
	env: CoreEnv,
	resourceId: string,
	step: WorkflowStep,
	depth = 0,
): Promise<readonly MarkdownSegmentTranslation[]> {
	const result = await step.do(
		`translate-zh-hant-markdown-${batch.id}-v15`,
		{ retries: { limit: 3, delay: translationRetryDelay }, timeout: '300 seconds' },
		async () => {
			try {
				return { ok: true as const, translations: await translateMarkdownBatchToZhHant(batch, env, resourceId) };
			} catch (error) {
				if (!isMarkdownTranslationFormatError(error)) throw error;
				// Persist the format failure so replay goes straight to the same smaller groups.
				return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	if (result.ok) return result.translations;
	if (batch.segments.length === 1) throw new MarkdownTranslationInvariantError('invalid-result', result.error);
	const groups = depth === 0 ? splitSegmentsInHalf(batch.segments) : batch.segments.map((segment) => [segment]);
	const translations: MarkdownSegmentTranslation[] = [];
	for (const [index, segments] of groups.entries()) {
		// Each subgroup has its own checkpoint; a later failure never redoes an earlier successful group.
		translations.push(
			...(await translateDurableBatch({ ...batch, id: `${batch.id}-${index + 1}`, segments }, env, resourceId, step, depth + 1)),
		);
	}
	return translations;
}

async function translatePlannedContent(content: string, env: CoreEnv, resourceId: string, step: WorkflowStep, task: ResourceTask) {
	const markdownPlan = planMarkdownTranslation(content);
	console.info({
		tag: 'RESOURCE_TRANSLATION',
		event: 'markdown_translation_planned',
		batch_count: markdownPlan.batches.length,
		resource_id: resourceId,
		segment_count: markdownPlan.segments.length,
		source_characters: content.length,
	});
	if (!markdownPlan.segments.length) {
		console.info({
			tag: 'RESOURCE_TRANSLATION',
			event: 'content_translation_outcome',
			outcome: 'skipped',
			reason: 'no-translatable-prose',
			resource_id: resourceId,
		});
		return null;
	}
	await task.report('batches-start', {
		stage: 'translating',
		status: 'running',
		completed: 0,
		total: markdownPlan.batches.length,
		resourceId,
	});
	const translatedBatches: (readonly MarkdownSegmentTranslation[])[] = [];
	let nextBatch = 0;
	let completed = 0;
	let failed = false;
	let progress = Promise.resolve();
	const workers = Array.from({ length: Math.min(MARKDOWN_TRANSLATION_CONCURRENCY, markdownPlan.batches.length) }, async () => {
		while (!failed && nextBatch < markdownPlan.batches.length) {
			const batchIndex = nextBatch++;
			const batch = markdownPlan.batches[batchIndex]!;
			try {
				translatedBatches[batchIndex] = await translateDurableBatch(batch, env, resourceId, step);
				const count = ++completed;
				// Serialize progress delivery; completion order differs from source order and can change on replay.
				progress = progress.then(() =>
					task.report(`batches-${count}`, {
						stage: 'translating',
						status: 'running',
						completed: count,
						total: markdownPlan.batches.length,
						resourceId,
					}),
				);
				await progress;
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	});
	// Drain in-flight work before reporting failure or sealing the task.
	const outcomes = await Promise.allSettled(workers);
	const failure = outcomes.find((outcome) => outcome.status === 'rejected');
	if (failure) throw failure.reason;
	const translated = compileMarkdownTranslationArtifact(markdownPlan, translatedBatches.flat());
	console.info({
		tag: 'RESOURCE_TRANSLATION',
		event: 'markdown_translation_compiled',
		resource_id: resourceId,
		aligned_blocks: translated.alignment.blocks.length,
		translated_characters: translated.content.length,
	});
	return translated;
}

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v30';
const ResourceTranslationRevisionSchema = z.hash('md5').lowercase();
const ForcedTranslationRunKeySchema = z.string().regex(/^[0-9a-f]{16}$/);

async function loadResourceTranslationInput(
	db: NodePgDatabase,
	resourceId: string,
): Promise<{ resource: ResourceTranslationInput; translationRevision: string } | null> {
	const result = await db.execute<ResourceTranslationInputRow>(sql`
		SELECT
			resource.file_type,
			resource.id::text AS id,
			resource.kind,
			resource.resource_platform,
			resource.original_lang,
			resource.scope,
			original.title AS title,
			original.summary AS summary,
			original.content AS content,
			zh_hant.title AS zh_hant_title,
			zh_hant.summary AS zh_hant_summary,
			zh_hant.content AS zh_hant_content,
			zh_hant.alignment->>'version' AS zh_hant_alignment_version,
			zh_hant.source AS zh_hant_source,
			resource.url,
			MD5(jsonb_build_array(
				original.lang,
				original.title,
				original.summary,
				original.content
			)::text) AS translation_revision
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN resource_translations zh_hant
		  ON zh_hant.resource_id = resource.id
		 AND zh_hant.lang = 'zh-Hant'
		WHERE resource.id = ${resourceId}::uuid
		  AND (
			resource.scope = 'corpus'
			OR ${privateUploadedPdfTranslationSqlAdmission()}
		  )
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) return null;
	const translationRevision = ResourceTranslationRevisionSchema.parse(row.translation_revision);
	const zhHantSource = row.zh_hant_source == null ? null : ResourceTranslationSourceSchema.parse(row.zh_hant_source);
	return {
		resource: {
			kind: row.kind,
			resourcePlatform: row.resource_platform,
			fileType: row.file_type,
			id: row.id,
			originalLang: canonicalizeResourceLang(row.original_lang),
			scope: row.scope,
			title: row.title ?? '',
			summary: row.summary,
			content: row.content ?? '',
			url: row.url,
			zhHantTranslation: zhHantSource
				? {
						aligned: row.zh_hant_alignment_version === '1',
						title: row.zh_hant_title?.trim() || null,
						summary: row.zh_hant_summary?.trim() || null,
						content: row.zh_hant_content?.trim() || null,
						source: zhHantSource,
					}
				: null,
		},
		translationRevision,
	};
}

async function persistMachineZhHantTranslation(
	db: NodePgDatabase,
	resourceId: string,
	translationRevision: string,
	patch: Readonly<MachineZhHantTranslationPatch>,
): Promise<boolean> {
	ResourceTranslationRevisionSchema.parse(translationRevision);
	if ((patch.content === undefined) !== (patch.alignment === undefined)) {
		throw new TypeError('Machine translation content and alignment must be persisted together');
	}
	const result = await db.execute<{ resource_id: string }>(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${resourceId}::uuid
			  AND (resource.scope = 'corpus' OR ${privateUploadedPdfTranslationSqlAdmission()})
			  AND EXISTS (
				SELECT 1
				FROM resource_translations original
				WHERE original.resource_id = resource.id
				  AND original.lang = resource.original_lang
				  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${translationRevision}
			  )
			FOR UPDATE OF resource
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, alignment, keywords, source, updated_at
		)
		SELECT
			target_resource.id, 'zh-Hant', ${patch.title ?? null}, ${patch.summary ?? null}, ${patch.content ?? null},
			${patch.alignment === undefined ? null : JSON.stringify(patch.alignment)}::jsonb,
			ARRAY[]::text[], 'machine', NOW()
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = COALESCE(EXCLUDED.title, current_translation.title),
			summary = COALESCE(EXCLUDED.summary, current_translation.summary),
			content = COALESCE(EXCLUDED.content, current_translation.content),
			alignment = COALESCE(EXCLUDED.alignment, current_translation.alignment),
			keywords = EXCLUDED.keywords,
			updated_at = NOW()
		WHERE current_translation.source = 'machine'
		RETURNING resource_id::text
	`);
	return result.rows.length > 0;
}

/** Follow one shared recovery chain, so concurrent imports cannot multiply paid work. */
async function currentTranslationAttempt(env: CoreEnv, resourceId: string, translationRevision: string) {
	let id = `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${translationRevision}`;
	for (let attempt = 0; attempt < 16; attempt++) {
		let snapshot: Awaited<ReturnType<WorkflowInstance['status']>>;
		try {
			snapshot = await (await env.RESOURCE_TRANSLATION_V2_WORKFLOW.get(id)).status();
		} catch {
			// An unavailable control plane cannot justify another physical task.
			// createBatch recovers this exact ID, including a lost response.
			return { id };
		}
		if (snapshot.status !== 'errored' && snapshot.status !== 'terminated') return { id, status: snapshot.status };
		if (attempt === 15) throw new Error('Translation retry limit reached');
		id = `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-retry-${resourceId}-${(await sha256Hex(id)).slice(0, 16)}`;
	}
	throw new Error('Translation retry limit reached');
}

// Normal ingestion dedupes by source revision. Explicit reacquisition supplies a deterministic run key so every operator resync
// receives a fresh instance while retries of the same processing Workflow remain idempotent.
export async function enqueueResourceTranslation(
	env: CoreEnv,
	resourceId: string,
	translationRevision: string,
	forceRunKey?: string,
	parent?: ResourceTaskContext,
): Promise<string> {
	ResourceTranslationRevisionSchema.parse(translationRevision);
	const validatedForceRunKey = forceRunKey === undefined ? null : ForcedTranslationRunKeySchema.parse(forceRunKey);
	let id = validatedForceRunKey
		? `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-force-${resourceId}-${validatedForceRunKey}`
		: `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${translationRevision}`;
	if (!validatedForceRunKey) {
		const attempt = await currentTranslationAttempt(env, resourceId, translationRevision);
		id = attempt.id;
		// Completed work already lives in ResourceTranslation. There is no new
		// execution to subscribe to, and no second source of progress to project.
		if (attempt.status === 'complete') return id;
	}
	// Shared work owns a ledger from the beginning, including automatic work.
	// A later user subscribes to the same durable reports instead of polling it.
	const registered = await env.APP.registerResourceProgressTask({
		taskId: id,
		kind: 'translation',
		resourceId,
		...(parent?.required ? { parentTaskId: parent.taskId } : {}),
	});
	if (!registered) throw new Error('Translation progress registration was rejected');
	await env.RESOURCE_TRANSLATION_V2_WORKFLOW.createBatch([
		{
			id,
			params: { ...(validatedForceRunKey ? { force: true } : {}), resourceId, translationRevision },
		},
	]);
	return id;
}

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(
		event: WorkflowEvent<ResourceTranslationPayload>,
		step: WorkflowStep,
	): Promise<{ status: 'complete' | 'skipped' | 'superseded'; resourceId: string }> {
		const { force = false, resourceId, translationRevision } = event.payload;
		const task = createResourceTask(this.env, step, event.instanceId);
		let translationPublished = false;
		try {
			if (!(await task.start('translating'))) return { status: 'superseded', resourceId };
			const inputStream = await step.do<ReadableStream<Uint8Array> | null>(
				'load-resource-translation-input-stream-v4',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
				async () => {
					const input = await loadResourceTranslationInput(await connectCoreDb(this.env), resourceId);
					return input ? Response.json(input).body! : null;
				},
			);
			const input = inputStream ? await new Response(inputStream).json<Awaited<ReturnType<typeof loadResourceTranslationInput>>>() : null;
			if (!input) {
				console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Resource original is unavailable; skipping', resource_id: resourceId });
				await task.report('missing', { stage: 'translating', status: 'skipped', resourceId });
				return { status: 'skipped', resourceId };
			}
			if (input.translationRevision !== translationRevision) {
				console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Translation revision was superseded; skipping', resource_id: resourceId });
				await task.report('superseded', {
					stage: 'translating',
					status: 'superseded',
					resourceId,
				});
				return { status: 'superseded', resourceId };
			}

			const resource = input.resource;
			const translationPlan = planZhHantTranslation(resource, force);
			if (!translationPlan.metadata && !translationPlan.content) {
				await task.report('unneeded', { stage: 'translating', status: 'skipped', resourceId });
				return { status: 'skipped', resourceId };
			}

			const patch: MachineZhHantTranslationPatch = {};
			const outcomes = await Promise.allSettled([
				(async () => {
					if (translationPlan.metadata) {
						const translatedMetadata = await step.do(
							'translate-zh-hant-title-summary-v3',
							{
								retries: { limit: 5, delay: translationRetryDelay },
								timeout: '180 seconds',
							},
							() => translateResourceMetadata(resource, this.env),
						);
						Object.assign(patch, translatedMetadata);
					}
				})(),
				(async () => {
					if (translationPlan.content) {
						try {
							const translated = await translatePlannedContent(resource.content.trim(), this.env, resourceId, step, task);
							if (translated) Object.assign(patch, translated);
						} catch (error) {
							console.error({
								tag: 'RESOURCE_TRANSLATION',
								event: 'content_translation_outcome',
								outcome: 'failed',
								reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
								error: error instanceof Error ? error.message : String(error),
								resource_id: resourceId,
							});
							throw error;
						}
					}
				})(),
			]);
			const failure = outcomes.find((outcome) => outcome.status === 'rejected');
			if (failure) throw failure.reason;

			if (patch.title === undefined && patch.summary === undefined && patch.content === undefined) {
				await task.report('empty', { stage: 'translating', status: 'skipped', resourceId });
				return { status: 'skipped', resourceId };
			}

			const persisted = await step.do(
				'persist-zh-hant-translation-v2',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
				async () => persistMachineZhHantTranslation(await connectCoreDb(this.env), resourceId, translationRevision, patch),
			);
			if (!persisted) {
				await task.report('persist-superseded', {
					stage: 'translating',
					status: 'superseded',
					resourceId,
				});
				if (patch.content !== undefined) {
					console.info({
						tag: 'RESOURCE_TRANSLATION',
						event: 'content_translation_outcome',
						outcome: 'superseded',
						resource_id: resourceId,
					});
				}
				return { status: 'superseded', resourceId };
			}
			if (patch.content !== undefined) {
				console.info({
					tag: 'RESOURCE_TRANSLATION',
					event: 'content_translation_outcome',
					outcome: 'persisted',
					resource_id: resourceId,
					translated_characters: patch.content.length,
				});
			}
			translationPublished = true;
			await task.report('complete', { stage: 'translating', status: 'complete', resourceId });
			if (resource.scope === 'corpus') {
				await step.do(
					'enqueue-translated-ai-search-sync-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => enqueueSearchProgress(this.env, resourceId, task, `${translationRevision}-zh-hant`),
				);
			}
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Completed', resource_id: resourceId, scope: resource.scope });
			return { status: 'complete', resourceId };
		} catch (error) {
			await task.report('outcome-after-error', {
				status: translationPublished ? 'complete' : 'failed',
				resourceId,
				...(translationPublished ? {} : { errorCode: 'translation_failed' }),
			});
			if (translationPublished) {
				console.error({ tag: 'RESOURCE_TRANSLATION', event: 'followup_dispatch_failed', resource_id: resourceId, error });
				return { status: 'complete', resourceId };
			}
			throw error;
		} finally {
			await task.seal();
		}
	}
}
