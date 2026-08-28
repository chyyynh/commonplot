// Durable translation execution; resource processing only enqueues this Workflow.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateText, Output } from 'ai';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { canonicalizeResourceLang, type RESOURCE_TYPES } from '../shared/resource';
import {
	compileMarkdownTranslation,
	type MarkdownSegmentTranslation,
	MarkdownTranslationInvariantError,
	planMarkdownTranslation,
} from './markdown-translation';
import { translateMarkdownBatchToZhHant } from './markdown-translation-model';
import { pdfTranslationAdmission, privateUploadedPdfTranslationSqlAdmission } from './platforms/pdf';

type ResourceTranslationPayload = { resourceId: string; translationRevision: string };
const TRANSLATABLE_RESOURCE_KINDS = ['blog', 'forum', 'post', 'paper'] as const;
const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;
type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];

type ResourceTranslationInput = {
	fileType: string | null;
	id: string;
	originalLang: string;
	scope: 'corpus' | 'private';
	title: string;
	summary: string | null;
	content: string;
	url: string | null;
	zhHantTranslation: {
		title: string | null;
		summary: string | null;
		content: string | null;
		source: ResourceTranslationSource;
	} | null;
} & {
	kind: keyof typeof RESOURCE_TYPES;
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null;
};

type ResourceTranslationInputRow = {
	file_type: string | null;
	id: string;
	kind: keyof typeof RESOURCE_TYPES;
	resource_platform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null;
	original_lang: string;
	scope: 'corpus' | 'private';
	title: string | null;
	summary: string | null;
	content: string | null;
	zh_hant_title: string | null;
	zh_hant_summary: string | null;
	zh_hant_content: string | null;
	zh_hant_source: string | null;
	translation_revision: string;
	url: string | null;
};

const METADATA_CONTENT_MAX_LENGTH = 10000;
const PARTIAL_CONTENT_TRANSLATION_RATIO = 0.2;
const MIN_TRANSLATABLE_TEXT_LENGTH = 20;
const INLINE_POST_CONTENT_TRANSLATION_MAX_LENGTH = 1000;

const ZhHantMetadataTranslationSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
});

const ZhHantTitleTranslationSchema = z.object({
	title: z.string().min(1),
});

const ZhHantPostTranslationSchema = z.object({
	title: z.string().min(1),
	content: z.string().min(1),
});

type ZhHantMetadataTranslationTask = 'article-title-summary' | 'paper-title' | 'paper-title-summary' | 'post-title' | 'post-title-content';

type ZhHantTranslationPlan = {
	metadata: ZhHantMetadataTranslationTask | null;
	content: 'translate' | null;
};

function isBlank(value: string | null | undefined): boolean {
	return !value?.trim();
}

function metadataTranslationTask(resource: ResourceTranslationInput): ZhHantMetadataTranslationTask | null {
	const translation = resource.zhHantTranslation;
	if (resource.kind === 'post') {
		const content = resource.content.trim();
		if (content && content.length <= INLINE_POST_CONTENT_TRANSLATION_MAX_LENGTH) {
			return isBlank(translation?.title) || isBlank(translation?.content) ? 'post-title-content' : null;
		}
		return isBlank(translation?.title) ? 'post-title' : null;
	}
	if (resource.kind === 'paper') {
		if (isBlank(resource.summary)) return isBlank(translation?.title) ? 'paper-title' : null;
		return isBlank(translation?.title) || isBlank(translation?.summary) ? 'paper-title-summary' : null;
	}
	return isBlank(translation?.title) || isBlank(translation?.summary) ? 'article-title-summary' : null;
}

function hasTranslatableContent(content: string): boolean {
	const text = content
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, '');
	return text.length >= MIN_TRANSLATABLE_TEXT_LENGTH;
}

function needsMachineContentTranslation(resource: ResourceTranslationInput): boolean {
	const translated = resource.zhHantTranslation?.content?.trim();
	if (!translated) return true;
	const content = resource.content.trim();
	if (!content || content.length < 1000) return false;
	return translated.length / content.length < PARTIAL_CONTENT_TRANSLATION_RATIO;
}

function planZhHantTranslation(resource: ResourceTranslationInput): ZhHantTranslationPlan {
	const translation = resource.zhHantTranslation;
	const pdfAdmission = pdfTranslationAdmission(resource);
	const privateUploadedPdf = pdfAdmission === 'private-upload';
	if (
		!(TRANSLATABLE_RESOURCE_KINDS as readonly string[]).includes(resource.kind) ||
		(!resource.url && !privateUploadedPdf) ||
		pdfAdmission === 'unsupported' ||
		isBlank(resource.title) ||
		isBlank(resource.content) ||
		resource.originalLang === 'zh-Hant' ||
		translation?.source === 'human'
	) {
		return { metadata: null, content: null };
	}

	const metadata = metadataTranslationTask(resource);
	const content = resource.content.trim();
	if (!content || !hasTranslatableContent(content) || !needsMachineContentTranslation(resource)) {
		return { metadata, content: null };
	}
	if (metadata === 'post-title-content') return { metadata, content: null };
	return { metadata, content: 'translate' };
}

function metadataTranslationRequest(task: ZhHantMetadataTranslationTask) {
	switch (task) {
		case 'post-title-content':
			return {
				schema: ZhHantPostTranslationSchema,
				maxOutputTokens: 2400,
				system: `你是專業的新聞翻譯編輯。請只輸出符合 schema 的繁體中文結果。

任務：
- title: 將標題翻譯成自然流暢的繁體中文
- content: 將完整貼文內容翻譯成自然流暢的繁體中文，不要摘要

規則：
- 忠實保留原文語氣，不要新增資訊
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然繁體中文
- 不要使用 Markdown。`,
			};
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
): Promise<
	| z.infer<typeof ZhHantMetadataTranslationSchema>
	| z.infer<typeof ZhHantTitleTranslationSchema>
	| z.infer<typeof ZhHantPostTranslationSchema>
> {
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
		model: createWorkersAI({ binding: env.AI })('@cf/qwen/qwen3.8-27b', {
			chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
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
): Promise<string | null> {
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
	for (const [index, batch] of markdownPlan.batches.entries()) {
		try {
			const translatedBatch = await step.do(
				`translate-zh-hant-markdown-${batch.id}-of-${String(markdownPlan.batches.length).padStart(4, '0')}-v1`,
				{ retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				(context) => translateMarkdownBatchToZhHant(batch, env, resourceId, index + 1, markdownPlan.batches.length, context.attempt),
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
		const translated = compileMarkdownTranslation(markdownPlan, translatedSegments);
		console.info({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_translation_compiled',
			resource_id: resourceId,
			translated_characters: translated.length,
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

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v9';
const RESOURCE_TRANSLATION_WORKFLOW_RETENTION = { successRetention: '1 day', errorRetention: '7 days' } as const;
const RESOURCE_TRANSLATION_REVISION_RE = /^[0-9a-f]{32}$/;

function isResourceTranslationRevision(value: unknown): value is string {
	return typeof value === 'string' && RESOURCE_TRANSLATION_REVISION_RE.test(value);
}

function parseTranslationSource(value: unknown): ResourceTranslationSource | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !(RESOURCE_TRANSLATION_SOURCES as readonly string[]).includes(value)) {
		throw new Error(`Invalid translation source: ${String(value)}`);
	}
	return value as ResourceTranslationSource;
}

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
	if (!isResourceTranslationRevision(row.translation_revision)) {
		throw new Error(`Invalid translation revision for ${resourceId}`);
	}
	const zhHantSource = parseTranslationSource(row.zh_hant_source);
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
						title: row.zh_hant_title?.trim() || null,
						summary: row.zh_hant_summary?.trim() || null,
						content: row.zh_hant_content?.trim() || null,
						source: zhHantSource,
					}
				: null,
		},
		translationRevision: row.translation_revision,
	};
}

async function persistMachineZhHantTranslation(
	db: NodePgDatabase,
	resourceId: string,
	translationRevision: string,
	patch: Readonly<{ title?: string; summary?: string; content?: string }>,
): Promise<boolean> {
	if (!isResourceTranslationRevision(translationRevision)) throw new TypeError('Resource translation revision is invalid');
	if (patch.title === undefined && patch.summary === undefined && patch.content === undefined) {
		throw new TypeError('Resource translation patch is empty');
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
			resource_id, lang, title, summary, content, keywords, source, updated_at
		)
		SELECT
			target_resource.id, 'zh-Hant', ${patch.title ?? null}, ${patch.summary ?? null}, ${patch.content ?? null},
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

// One stable instance per translation revision dedupes duplicate enqueue calls;
// a changed original gets a new ID.
export async function enqueueResourceTranslation(env: CoreEnv, resourceId: string, translationRevision: string): Promise<string> {
	if (!isResourceTranslationRevision(translationRevision)) throw new Error('Invalid resource translation revision');
	const id = `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${translationRevision}`;
	await env.RESOURCE_TRANSLATION_V2_WORKFLOW.createBatch([
		{ id, params: { resourceId, translationRevision }, retention: RESOURCE_TRANSLATION_WORKFLOW_RETENTION },
	]);
	return id;
}

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(event: WorkflowEvent<ResourceTranslationPayload>, step: WorkflowStep) {
		const { resourceId, translationRevision } = event.payload;
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
		const translationPlan = planZhHantTranslation(resource);
		const metadataTask = translationPlan.metadata;
		if (!metadataTask && translationPlan.content !== 'translate') return;
		const initialContent = resource.content.trim();
		if (!initialContent) throw new Error(`Resource ${resourceId} has no persisted original content`);

		if (metadataTask) {
			const translatedMetadata = await step.do(
				'translate-zh-hant-title-summary',
				{
					retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
					timeout: '180 seconds',
				},
				() => generateZhHantMetadataTranslation(resource, this.env, metadataTask),
			);
			const persisted = await step.do(
				'persist-zh-hant-title-summary',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => persistMachineZhHantTranslation(await connectCoreDb(this.env), resourceId, translationRevision, translatedMetadata),
			);
			if (!persisted) return;
		}

		const translated = await translatePlannedContent(initialContent, translationPlan.content, this.env, resourceId, step);
		if (translated !== null) {
			const persisted = await step.do(
				'persist-zh-hant-content',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
				async () =>
					persistMachineZhHantTranslation(await connectCoreDb(this.env), resourceId, translationRevision, { content: translated }),
			);
			if (!persisted) {
				console.info({
					tag: 'RESOURCE_TRANSLATION',
					event: 'content_translation_outcome',
					outcome: 'superseded',
					resource_id: resourceId,
				});
				return;
			}
			console.info({
				tag: 'RESOURCE_TRANSLATION',
				event: 'content_translation_outcome',
				outcome: 'persisted',
				resource_id: resourceId,
				translated_characters: translated.length,
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
