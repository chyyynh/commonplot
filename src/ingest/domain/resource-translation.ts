import { type ResourceIdentityColumns, type ResourceTranslationSource, ZH_HANT_RESOURCE_LANG } from '@core-shared/resource-types';
import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

const METADATA_CONTENT_MAX_LENGTH = 10000;
/**
 * Ceiling for translating a body in one call. Measured on qwen3-30b: ~0.165
 * input and ~0.29 output tokens per source character at ~108 output tokens/s,
 * so 36k characters is ~18k of the 32k context and ~97s against the 180s step
 * timeout. It covers 98% of the corpus; longer bodies (overwhelmingly Hacker
 * News comment dumps) keep their original text instead of being split up.
 */
export const CONTENT_TRANSLATION_MAX_LENGTH = 36000;
const PARTIAL_CONTENT_TRANSLATION_RATIO = 0.2;
const MIN_TRANSLATABLE_TEXT_LENGTH = 20;
const INLINE_TWITTER_CONTENT_TRANSLATION_MAX_LENGTH = 1000;

export type ResourceTranslationInput = {
	id: string;
	original_lang: string;
	title: string;
	summary: string | null;
	content: string;
	zhHantTranslation: {
		title: string | null;
		summary: string | null;
		content: string | null;
		source: ResourceTranslationSource;
	} | null;
} & ResourceIdentityColumns;

const ZhHantMetadataTranslationSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
});

const ZhHantTitleTranslationSchema = z.object({
	title: z.string().min(1),
});

const ZhHantTwitterTranslationSchema = z.object({
	title: z.string().min(1),
	content: z.string().min(1),
});

export type ZhHantMetadataTranslationTask =
	| 'article-title-summary'
	| 'paper-title'
	| 'paper-title-summary'
	| 'twitter-title'
	| 'twitter-title-content';

type ZhHantTranslationPlan = {
	metadata: ZhHantMetadataTranslationTask | null;
	content: 'translate' | 'skip-too-long' | null;
};

function isBlank(value: string | null | undefined): boolean {
	return !value?.trim();
}

function usesInlineTwitterContentTranslation(resource: ResourceTranslationInput): boolean {
	const content = resource.content.trim();
	return resource.resource_platform === 'twitter' && !!content && content.length <= INLINE_TWITTER_CONTENT_TRANSLATION_MAX_LENGTH;
}

function metadataTranslationTask(resource: ResourceTranslationInput): ZhHantMetadataTranslationTask | null {
	const translation = resource.zhHantTranslation;
	if (resource.resource_platform === 'twitter') {
		if (usesInlineTwitterContentTranslation(resource)) {
			return isBlank(translation?.title) || isBlank(translation?.content) ? 'twitter-title-content' : null;
		}
		return isBlank(translation?.title) ? 'twitter-title' : null;
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

export function planZhHantTranslation(resource: ResourceTranslationInput): ZhHantTranslationPlan {
	const translation = resource.zhHantTranslation;
	if (resource.original_lang === ZH_HANT_RESOURCE_LANG || translation?.source === 'human') {
		return { metadata: null, content: null };
	}

	const metadata = metadataTranslationTask(resource);
	const content = resource.content.trim();
	if (!content || !hasTranslatableContent(content) || !needsMachineContentTranslation(resource)) {
		return { metadata, content: null };
	}
	if (metadata === 'twitter-title-content') return { metadata, content: null };
	return { metadata, content: content.length > CONTENT_TRANSLATION_MAX_LENGTH ? 'skip-too-long' : 'translate' };
}

function metadataTranslationRequest(task: ZhHantMetadataTranslationTask) {
	switch (task) {
		case 'twitter-title-content':
			return {
				schema: ZhHantTwitterTranslationSchema,
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
		case 'twitter-title':
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

function requiredResourceContent(resource: ResourceTranslationInput): string {
	const content = resource.content.trim();
	if (!content) throw new Error(`Resource ${resource.id} has no content`);
	return content;
}

export async function generateZhHantMetadataTranslation(
	resource: ResourceTranslationInput,
	env: CoreEnv,
	task: ZhHantMetadataTranslationTask,
): Promise<
	| z.infer<typeof ZhHantMetadataTranslationSchema>
	| z.infer<typeof ZhHantTitleTranslationSchema>
	| z.infer<typeof ZhHantTwitterTranslationSchema>
> {
	const content = requiredResourceContent(resource);
	const summaryLine = resource.summary?.trim() ? `\n摘要：${resource.summary.trim()}` : '';
	const prompt = `原文資訊：
資源種類：${resource.kind}
資源平台：${resource.resource_platform ?? 'none'}
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

export async function translateZhHantContent(content: string, env: CoreEnv, resourceId: string): Promise<string> {
	const { finishReason, text } = await generateText({
		model: createWorkersAI({ binding: env.AI })('@cf/qwen/qwen3-30b-a3b-fp8', {
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'resource-content-translation',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					resource_id: resourceId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt: `原文 Markdown:\n${content.trim()}`,
		// Measured on real bodies: ~0.31 output tokens per source character, so a
		// 36k-character body lands near 11.1k. Leave room above that — the
		// finish_reason guard turns a clipped response into a failed translation,
		// so this cap must not be reachable by an in-policy body.
		maxOutputTokens: 16000,
		temperature: 0.2,
		system: RESOURCE_CONTENT_TRANSLATION_SYSTEM_PROMPT,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource content translation hit its output token cap');
	const output = text.trim();
	if (!output) throw new Error('Resource content translation returned no text');
	return output;
}
