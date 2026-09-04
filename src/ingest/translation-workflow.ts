// Durable translation execution; resource processing only enqueues this Workflow.
import { type WorkflowDynamicDelayContext, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateText, Output } from 'ai';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { canonicalizeResourceLang } from '../shared/resource';
import { CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';
import {
	compileMarkdownTranslationArtifact,
	type MarkdownSegmentTranslation,
	type MarkdownTranslationAlignment,
	MarkdownTranslationInvariantError,
	planMarkdownTranslation,
} from './markdown-translation';
import { translateMarkdownBatchToZhHant } from './markdown-translation-model';
import { PDF_MIME } from './platforms/pdf-constants';
import { type ResourceTranslationCandidate, shouldEnqueueResourceTranslation } from './translation-policy';

type ResourceTranslationPayload = { force?: boolean; resourceId: string; translationRevision: string };
const ResourceTranslationSourceSchema = z.enum(['original', 'machine', 'human']);
type ResourceTranslationSource = z.infer<typeof ResourceTranslationSourceSchema>;

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
		source: ResourceTranslationSource;
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

const METADATA_CONTENT_MAX_LENGTH = 10000;
const PARTIAL_CONTENT_TRANSLATION_RATIO = 0.2;
const MIN_TRANSLATABLE_TEXT_LENGTH = 20;
const AI_RATE_LIMIT_ERROR = /\b(?:3021|429)\b|rate limit|too many requests/iu;

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

const ZhHantMetadataTranslationSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
});

const ZhHantTitleTranslationSchema = ZhHantMetadataTranslationSchema.pick({ title: true });

type ZhHantMetadataTranslationTask = 'article-title-summary' | 'paper-title' | 'paper-title-summary' | 'post-title';

type ZhHantTranslationPlan = {
	metadata: ZhHantMetadataTranslationTask | null;
	content: 'translate' | null;
};

type MachineZhHantTranslationPatch = {
	alignment?: MarkdownTranslationAlignment;
	content?: string;
	summary?: string;
	title?: string;
};

function isBlank(value: string | null | undefined): boolean {
	return !value?.trim();
}

function metadataTranslationTask(resource: ResourceTranslationInput, force: boolean): ZhHantMetadataTranslationTask | null {
	const translation = resource.zhHantTranslation;
	if (resource.kind === 'post') {
		return force || isBlank(translation?.title) ? 'post-title' : null;
	}
	if (resource.kind === 'paper') {
		if (isBlank(resource.summary)) return force || isBlank(translation?.title) ? 'paper-title' : null;
		return force || isBlank(translation?.title) || isBlank(translation?.summary) ? 'paper-title-summary' : null;
	}
	return force || isBlank(translation?.title) || isBlank(translation?.summary) ? 'article-title-summary' : null;
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
		return { metadata: null, content: null };
	}

	const metadata = metadataTranslationTask(resource, force);
	if (!hasTranslatableContent(resource.content) || (!force && !needsMachineContentTranslation(resource))) {
		return { metadata, content: null };
	}
	return { metadata, content: 'translate' };
}

function metadataTranslationRequest(task: ZhHantMetadataTranslationTask) {
	switch (task) {
		case 'post-title':
			return {
				schema: ZhHantTitleTranslationSchema,
				maxOutputTokens: 400,
				system: `你是專業的新聞翻譯編輯。請只輸出符合 schema 的繁體中文結果。

任務：
- title: 將標題翻譯成自然流暢的繁體中文

規則：
- 忠實保留原文語氣，不要新增資訊
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然繁體中文
- 不要使用 Markdown。`,
			};
		case 'paper-title':
		case 'paper-title-summary':
			return {
				schema: task === 'paper-title' ? ZhHantTitleTranslationSchema : ZhHantMetadataTranslationSchema,
				maxOutputTokens: task === 'paper-title' ? 500 : 2400,
				system: `你是專業的學術翻譯編輯。請只輸出符合 schema 的繁體中文結果。

任務：
- title: 將論文標題翻譯成自然、準確的繁體中文
${task === 'paper-title-summary' ? '- summary: 將作者原始摘要完整翻譯成繁體中文，不要濃縮或改寫' : ''}

規則：
- 忠實保留學術術語、論證與限定語
- 不要新增資訊，不要把摘要改寫成 AI summary
- 不要使用 Markdown。`,
			};
		case 'article-title-summary':
			return {
				schema: ZhHantMetadataTranslationSchema,
				maxOutputTokens: 700,
				system: `你是專業的新聞翻譯編輯。請只輸出符合 schema 的台灣繁體中文結果。

任務：
- title: 將標題翻譯成自然流暢的繁體中文
- summary: 若原文提供摘要，忠實完整翻譯該摘要；只有原文摘要缺失時，才根據內容產生 1-2 句繁體中文摘要

規則：
- 忠實保留原文語氣、限定與不確定性，不要推論或新增資訊
- 使用台灣常用詞彙與標點；若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然的台灣繁體中文
- 不要使用 Markdown。`,
			};
	}
}

async function generateZhHantMetadataTranslation(
	resource: ResourceTranslationInput,
	env: CoreEnv,
	task: ZhHantMetadataTranslationTask,
): Promise<z.infer<typeof ZhHantMetadataTranslationSchema> | z.infer<typeof ZhHantTitleTranslationSchema>> {
	const content = resource.content.trim();
	if (!content) throw new Error(`Resource ${resource.id} has no content`);
	const summaryLine = resource.summary?.trim() ? `\n摘要：${resource.summary.trim()}` : '';
	const prompt = `原文資訊：
資源種類：${resource.kind}
資源平台：${resource.resourcePlatform ?? 'none'}
標題：${resource.title}${summaryLine}
內容：
${content.slice(0, METADATA_CONTENT_MAX_LENGTH)}`;
	const request = metadataTranslationRequest(task);
	const { finishReason, output } = await generateText({
		model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
			...CORE_STRUCTURED_MODEL_SETTINGS,
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'resource-metadata-localization',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					resource_id: resource.id,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt,
		system: request.system,
		output: Output.object({
			name: 'resource_translation_metadata',
			description: 'Faithful Taiwan Traditional Chinese localization of the requested resource metadata fields.',
			schema: request.schema,
		}),
		maxOutputTokens: request.maxOutputTokens,
		temperature: 0.3,
		reasoning: 'none',
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource metadata localization hit its output token cap');
	return output;
}

async function translatePlannedContent(
	content: string,
	plan: ZhHantTranslationPlan['content'],
	env: CoreEnv,
	resourceId: string,
	step: WorkflowStep,
) {
	if (plan !== 'translate') return null;
	let markdownPlan: ReturnType<typeof planMarkdownTranslation>;
	try {
		markdownPlan = planMarkdownTranslation(content);
	} catch (error) {
		console.error({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_validation_failed',
			reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
			resource_id: resourceId,
		});
		console.info({
			tag: 'RESOURCE_TRANSLATION',
			event: 'content_translation_outcome',
			outcome: 'original-fallback',
			reason: 'source-markdown-invalid',
			resource_id: resourceId,
		});
		throw error;
	}
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
			outcome: 'original-fallback',
			reason: 'no-translatable-prose',
			resource_id: resourceId,
		});
		return null;
	}
	const translatedSegments: MarkdownSegmentTranslation[] = [];
	for (const batch of markdownPlan.batches) {
		try {
			const translatedBatch = await step.do(
				`translate-zh-hant-markdown-${batch.id}-of-${String(markdownPlan.batches.length).padStart(4, '0')}-v9`,
				{ retries: { limit: 3, delay: translationRetryDelay }, timeout: '300 seconds' },
				(context) => translateMarkdownBatchToZhHant(batch, env, resourceId, context.attempt),
			);
			translatedSegments.push(...translatedBatch);
		} catch (error) {
			console.info({
				tag: 'RESOURCE_TRANSLATION',
				event: 'content_translation_outcome',
				outcome: 'original-fallback',
				reason: 'batch-recovery-exhausted',
				batch_id: batch.id,
				resource_id: resourceId,
			});
			throw error;
		}
	}
	try {
		const translated = compileMarkdownTranslationArtifact(markdownPlan, translatedSegments);
		console.info({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_translation_compiled',
			resource_id: resourceId,
			aligned_blocks: translated.alignment.blocks.length,
			translated_characters: translated.content.length,
		});
		return translated;
	} catch (error) {
		console.error({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_validation_failed',
			reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
			resource_id: resourceId,
		});
		console.info({
			tag: 'RESOURCE_TRANSLATION',
			event: 'content_translation_outcome',
			outcome: 'original-fallback',
			reason: 'markdown-structure-invalid',
			resource_id: resourceId,
		});
		throw error;
	}
}

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v22';
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
			title = CASE
				WHEN current_translation.source IN ('human', 'original') OR ${patch.title === undefined}
					THEN current_translation.title
				ELSE EXCLUDED.title
			END,
			summary = CASE
				WHEN current_translation.source IN ('human', 'original') OR ${patch.summary === undefined}
					THEN current_translation.summary
				ELSE EXCLUDED.summary
			END,
			content = CASE
				WHEN current_translation.source IN ('human', 'original') OR ${patch.content === undefined}
					THEN current_translation.content
				ELSE EXCLUDED.content
			END,
			alignment = CASE
				WHEN current_translation.source IN ('human', 'original') OR ${patch.content === undefined}
					THEN current_translation.alignment
				ELSE EXCLUDED.alignment
			END,
			keywords = CASE
				WHEN current_translation.source IN ('human', 'original') THEN current_translation.keywords
				ELSE EXCLUDED.keywords
			END,
			source = CASE
				WHEN current_translation.source IN ('human', 'original') THEN current_translation.source
				ELSE EXCLUDED.source
			END,
			updated_at = NOW()
		RETURNING resource_id::text
	`);
	return result.rows.length > 0;
}

// Normal ingestion dedupes by source revision. Explicit reacquisition supplies a deterministic run key so every operator resync
// receives a fresh instance while retries of the same processing Workflow remain idempotent.
export async function enqueueResourceTranslation(
	env: CoreEnv,
	resourceId: string,
	translationRevision: string,
	forceRunKey?: string,
): Promise<string> {
	ResourceTranslationRevisionSchema.parse(translationRevision);
	const validatedForceRunKey = forceRunKey === undefined ? null : ForcedTranslationRunKeySchema.parse(forceRunKey);
	const id = validatedForceRunKey
		? `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-force-${resourceId}-${validatedForceRunKey}`
		: `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${translationRevision}`;
	await env.RESOURCE_TRANSLATION_V2_WORKFLOW.createBatch([
		{
			id,
			params: { ...(validatedForceRunKey ? { force: true } : {}), resourceId, translationRevision },
		},
	]);
	return id;
}

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(event: WorkflowEvent<ResourceTranslationPayload>, step: WorkflowStep) {
		const { force = false, resourceId, translationRevision } = event.payload;
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
			return;
		}
		if (input.translationRevision !== translationRevision) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Translation revision was superseded; skipping', resource_id: resourceId });
			return;
		}

		const resource = input.resource;
		const translationPlan = planZhHantTranslation(resource, force);
		const metadataTask = translationPlan.metadata;
		if (!metadataTask && translationPlan.content !== 'translate') return;
		const initialContent = resource.content.trim();
		if (!initialContent) throw new Error(`Resource ${resourceId} has no persisted original content`);

		const patch: MachineZhHantTranslationPatch = {};
		if (metadataTask) {
			const translatedMetadata = await step.do(
				'translate-zh-hant-title-summary-v2',
				{
					retries: { limit: 5, delay: translationRetryDelay },
					timeout: '180 seconds',
				},
				() => generateZhHantMetadataTranslation(resource, this.env, metadataTask),
			);
			Object.assign(patch, translatedMetadata);
		}

		const translated = await translatePlannedContent(initialContent, translationPlan.content, this.env, resourceId, step);
		if (translated) Object.assign(patch, translated);
		if (patch.title === undefined && patch.summary === undefined && patch.content === undefined) return;

		const persisted = await step.do(
			'persist-zh-hant-translation-v2',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			async () => persistMachineZhHantTranslation(await connectCoreDb(this.env), resourceId, translationRevision, patch),
		);
		if (!persisted) {
			if (patch.content !== undefined) {
				console.info({
					tag: 'RESOURCE_TRANSLATION',
					event: 'content_translation_outcome',
					outcome: 'superseded',
					resource_id: resourceId,
				});
			}
			return;
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
		if (resource.scope === 'corpus') {
			await step.do(
				'enqueue-translated-ai-search-sync-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId }),
			);
		}
		console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Completed', resource_id: resourceId, scope: resource.scope });
	}
}
