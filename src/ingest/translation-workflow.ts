// Durable translation execution; resource processing only enqueues this Workflow.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { connectCoreDb } from '@core-shared/db';
import { canonicalizeResourceLang, type RESOURCE_TYPES } from '@core-shared/resource';
import { generateText, Output } from 'ai';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { syncCorpusItem } from '../search-index';
import { pdfTranslationAdmission, privateUploadedPdfTranslationSqlAdmission, stagePrivatePdfMarkdownTranslation } from './platforms/pdf';

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
/**
 * Ceiling for translating a body in one call. Measured on qwen3-30b: ~0.165
 * input and ~0.29 output tokens per source character at ~108 output tokens/s,
 * so 36k characters is ~18k of the 32k context and ~97s against the 180s step
 * timeout. It covers 98% of the corpus; longer corpus bodies (overwhelmingly
 * Hacker News comment dumps) keep their original text, while private uploaded
 * PDFs use deterministic platform-owned chunks.
 */
const CONTENT_TRANSLATION_MAX_LENGTH = 36000;
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
	content: 'translate' | 'translate-private-file' | 'skip-too-long' | null;
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
	return {
		metadata,
		content:
			content.length <= CONTENT_TRANSLATION_MAX_LENGTH ? 'translate' : privateUploadedPdf ? 'translate-private-file' : 'skip-too-long',
	};
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
				system: `你是專業的新聞翻譯和摘要編輯。請只輸出符合 schema 的繁體中文結果。

任務：
- title: 將標題翻譯成自然流暢的繁體中文
- summary: 根據原文標題、摘要與內容，產生 1-2 句繁體中文摘要

規則：
- 忠實保留原文語氣，不要新增資訊
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然繁體中文
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
		model: createWorkersAI({ binding: env.AI })('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
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
		output: Output.object({ schema: request.schema }),
		maxOutputTokens: request.maxOutputTokens,
		temperature: 0.3,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource metadata localization hit its output token cap');
	return output;
}

const RESOURCE_CONTENT_TRANSLATION_SYSTEM_PROMPT = `你是專業的新聞全文翻譯編輯。請將原文完整翻譯成自然流暢的繁體中文。

規則：
- 忠實翻譯原文，不要摘要、不要評論、不要新增資訊
- 保留 Markdown 結構、標題層級、列表、引用、連結和程式碼區塊
- 專有名詞保留常見英文名稱；必要時可在中文後保留英文
- 若原文已是繁體中文，直接保留原文；若是簡體中文，轉為自然繁體中文
- 直接輸出翻譯後的 Markdown，不要包 code block。`;

async function translateZhHantContent(
	content: string,
	env: CoreEnv,
	resourceId: string,
	chunk: Readonly<{ index: number; total: number }> | null = null,
): Promise<string> {
	const { finishReason, text } = await generateText({
		model: createWorkersAI({ binding: env.AI })('@cf/qwen/qwen3-30b-a3b-fp8', {
			chat_template_kwargs: { enable_thinking: false },
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					...(chunk ? { chunk_count: chunk.total, chunk_index: chunk.index } : {}),
					feature: 'resource-content-translation',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					resource_id: resourceId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt: `${chunk ? `原文 Markdown（第 ${chunk.index}/${chunk.total} 段；只翻譯本段，不要補寫前後文）` : '原文 Markdown'}:\n${content.trim()}`,
		// Translation does not benefit from reasoning. A 12k-character chunk
		// produces roughly 3.5k output tokens; 8k leaves capacity headroom while
		// the finish-reason guard still owns any unexpected expansion.
		maxOutputTokens: 8000,
		temperature: 0.2,
		system: RESOURCE_CONTENT_TRANSLATION_SYSTEM_PROMPT,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource content translation hit its output token cap');
	const output = text.trim();
	if (!output) throw new Error('Resource content translation returned no text');
	return output;
}

async function translatePlannedContent(
	content: string,
	plan: ZhHantTranslationPlan['content'],
	env: CoreEnv,
	resourceId: string,
	step: WorkflowStep,
): Promise<string | null> {
	if (plan === 'translate') {
		return step.do(
			'translate-zh-hant-content',
			{ retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
			() => translateZhHantContent(content, env, resourceId),
		);
	}
	if (plan !== 'translate-private-file') return null;
	return stagePrivatePdfMarkdownTranslation(step, content, (markdown, chunk) => translateZhHantContent(markdown, env, resourceId, chunk));
}

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v7';
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
		if (translationPlan.content === 'skip-too-long') {
			console.info({
				tag: 'RESOURCE_TRANSLATION',
				msg: 'Body too long to translate in one call; keeping the original',
				resource_id: resource.id,
				chars: resource.content.trim().length,
				limit: CONTENT_TRANSLATION_MAX_LENGTH,
			});
		}
		const metadataTask = translationPlan.metadata;
		if (!metadataTask && translationPlan.content !== 'translate' && translationPlan.content !== 'translate-private-file') {
			return;
		}
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
				() =>
					this.env.DOMAIN.persistMachineZhHantTranslation({
						resourceId,
						translationRevision,
						patch: translatedMetadata,
					}),
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
				() =>
					this.env.DOMAIN.persistMachineZhHantTranslation({
						resourceId,
						translationRevision,
						patch: { content: translated },
					}),
			);
			if (!persisted) return;
		}
		if (resource.scope === 'corpus') {
			await step.do(
				'sync-translated-resource-to-ai-search',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '90 seconds' },
				async () => syncCorpusItem(this.env, await connectCoreDb(this.env), resourceId),
			);
		}
		console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Completed', resource_id: resourceId, scope: resource.scope });
	}
}
