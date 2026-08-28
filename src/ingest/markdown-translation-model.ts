import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import {
	type MarkdownSegmentTranslation,
	type MarkdownTranslationBatch,
	MarkdownTranslationInvariantError,
	type MarkdownTranslationSegment,
	validateMarkdownBatchTranslations,
} from './markdown-translation';

const ZhHantMarkdownSegmentTranslationsSchema = z
	.object({
		segments: z.array(
			z
				.object({
					id: z.string().min(1),
					text: z.string().min(1),
				})
				.strict(),
		),
	})
	.strict();

const ZH_HANT_MARKDOWN_TRANSLATION_SYSTEM_PROMPT = `你是專業的全文翻譯編輯。目標語言是自然、準確、符合台灣讀者習慣的繁體中文。

輸入契約：
- 每個 segment 的 text 是一個完整段落、標題、表格儲存格，或超長純文字段落的一個完整句界切片
- 只翻譯 text 中的自然語言；context 只供消歧義，不屬於輸出
- <pc id="...">...</pc> 與 <ph id="..."/> 是 XML placeholders，代表原文的格式、連結、圖片、程式碼、公式或 HTML；標籤、id、數量、順序與巢狀結構必須逐字保留

翻譯準則：
- 每個 segment 只翻譯一次並完整輸出，不要把相鄰 segment 或 context 的內容重複寫入
- 忠實完整翻譯，不要摘要、評論、解釋、補充背景或新增原文沒有的資訊
- 保留原文語氣、時態、否定、程度、條件、不確定性、引述關係、數字、單位與引用指向
- 使用台灣常用詞彙與標點；人名、組織、產品和技術術語有通行譯名時採用通行譯名，沒有時保留原文，不要自創譯名或縮寫
- 若 text 已是繁體中文，保留自然表達；若是簡體中文，轉為自然的台灣繁體中文

輸出契約：
- 只輸出符合 schema 的結果；segments 的數量、順序與 id 必須和輸入完全相同
- 不得遺漏、新增、合併、拆分或重新排序 segment
- 每個 text 只輸出含原有 XML placeholders 的譯文純文字；不要輸出 Markdown、額外 HTML、code block、說明、前後空白或額外段落。`;

type TranslationRecoveryStrategy = 'batch' | 'halves' | 'individual';

type TranslationGroup = Readonly<{
	index: number;
	segments: readonly MarkdownTranslationSegment[];
	strategy: TranslationRecoveryStrategy;
	total: number;
}>;

function splitSegmentsInHalf(segments: readonly MarkdownTranslationSegment[]): readonly (readonly MarkdownTranslationSegment[])[] {
	if (segments.length <= 1) return [segments];
	const totalCharacters = segments.reduce((total, segment) => total + segment.text.length + (segment.context?.length ?? 0), 0);
	const targetCharacters = totalCharacters / 2;
	let consumedCharacters = 0;
	let splitIndex = 1;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		if (!segment) break;
		consumedCharacters += segment.text.length + (segment.context?.length ?? 0);
		splitIndex = index + 1;
		if (consumedCharacters >= targetCharacters) break;
	}
	return [segments.slice(0, splitIndex), segments.slice(splitIndex)];
}

function translationGroups(batch: MarkdownTranslationBatch, attempt: number): TranslationGroup[] {
	const strategy: TranslationRecoveryStrategy = attempt <= 2 ? 'batch' : attempt === 3 ? 'halves' : 'individual';
	const groups =
		strategy === 'batch'
			? [batch.segments]
			: strategy === 'halves'
				? splitSegmentsInHalf(batch.segments)
				: batch.segments.map((segment) => [segment]);
	return groups.map((segments, index) => ({ index: index + 1, segments, strategy, total: groups.length }));
}

async function translateGroup(
	group: TranslationGroup,
	batch: MarkdownTranslationBatch,
	env: CoreEnv,
	resourceId: string,
	batchIndex: number,
	batchTotal: number,
): Promise<readonly MarkdownSegmentTranslation[]> {
	const { finishReason, output } = await generateText({
		model: createWorkersAI({ binding: env.AI })('@cf/qwen/qwen3-30b-a3b-fp8', {
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					batch_count: batchTotal,
					batch_id: batch.id,
					batch_index: batchIndex,
					environment: env.AI_GATEWAY_ENVIRONMENT,
					feature: 'resource-content-translation',
					recovery_strategy: group.strategy,
					resource_id: resourceId,
					sub_batch_count: group.total,
					sub_batch_index: group.index,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt: `${JSON.stringify({
			targetLocale: 'zh-Hant',
			editorialVariant: 'zh-TW',
			segments: group.segments.map(({ context, id, text }) => ({ context, id, text })),
		})}\n/no_think`,
		system: ZH_HANT_MARKDOWN_TRANSLATION_SYSTEM_PROMPT,
		output: Output.object({ schema: ZhHantMarkdownSegmentTranslationsSchema }),
		maxOutputTokens: 8000,
		temperature: 0.2,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Markdown segment translation hit its output token cap');
	return validateMarkdownBatchTranslations({ segments: group.segments }, output.segments);
}

export async function translateMarkdownBatchToZhHant(
	batch: MarkdownTranslationBatch,
	env: CoreEnv,
	resourceId: string,
	batchIndex: number,
	batchTotal: number,
	attempt: number,
): Promise<readonly MarkdownSegmentTranslation[]> {
	const groups = translationGroups(batch, attempt);
	if (attempt > 1) {
		console.warn({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_batch_recovery',
			attempt,
			batch_id: batch.id,
			group_count: groups.length,
			resource_id: resourceId,
			strategy: groups[0]?.strategy ?? 'individual',
		});
	}
	try {
		const translated: MarkdownSegmentTranslation[] = [];
		for (const group of groups) {
			translated.push(...(await translateGroup(group, batch, env, resourceId, batchIndex, batchTotal)));
		}
		return validateMarkdownBatchTranslations(batch, translated);
	} catch (error) {
		console.error({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_batch_attempt_failed',
			attempt,
			batch_id: batch.id,
			reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
			resource_id: resourceId,
		});
		throw error;
	}
}
