import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';
import {
	type MarkdownSegmentTranslation,
	type MarkdownTranslationBatch,
	MarkdownTranslationInvariantError,
	type MarkdownTranslationSegment,
	validateMarkdownBatchTranslations,
} from './markdown-translation';

function zhHantMarkdownTranslationsSchema(segments: readonly MarkdownTranslationSegment[]) {
	return z.strictObject({
		translations: z
			.strictObject(
				Object.fromEntries(
					segments.map(({ id }) => [id, z.string().min(1).describe(`Complete Taiwan Traditional Chinese translation for ${id}.`)]),
				),
			)
			.describe('One complete prose-block translation for every input segment ID.'),
	});
}

const ZH_HANT_MARKDOWN_TRANSLATION_SYSTEM_PROMPT = `你是專業的全文翻譯編輯。目標語言是自然、準確、符合台灣讀者習慣的繁體中文。

輸入契約：
- 每個 segment 的 text 是一個完整標題、段落、表格儲存格，或超長純文字段落的一個完整句界切片
- 只翻譯 text 中的自然語言；context 只供消歧義，不屬於輸出
- <n-000000>...</n-000000> 與 <n-000000/> 這類標記是不可修改的 opaque XML placeholders，代表連結、強調、圖片、程式碼、公式、HTML 或其他 inline 結構

翻譯準則：
- 以整個段落的意思與論述關係翻譯，不要逐片語直譯；為了自然的台灣中文，可以調整語序、拆合子句與更換慣用句型
- 維持同一批段落的敘事語氣與術語一致；每個 segment 仍須只翻譯一次並完整輸出，不要重複相鄰 segment 或 context
- 忠實完整翻譯，不要摘要、評論、解釋、補充背景或新增原文沒有的資訊
- 保留原文語氣、時態、否定、程度、條件、不確定性、引述關係、數字、單位與引用指向
- 使用台灣常用詞彙與自然的繁體中文標點；中文敘述通常使用全形的，。；：！？、（）與「」『』，不要機械沿用英文半形標點。URL、email、程式碼、版本號、小數與完整英文片語內的符號仍照原文保留
- 人名、組織、產品和技術術語有通行譯名時採用通行譯名，沒有時保留原文，不要自創譯名或縮寫
- 採用台灣慣用詞，例如「新創公司」、「機車」、「載貨自行車」、「城市移動」；避免「初創」、「摩托車」、「出行」、「貨物自行車」等非台灣慣用詞
- 一般介面與商業詞彙應自然翻譯，不要把 configurator 等非專有名詞無故保留成英文
- 若 text 已是繁體中文，保留自然表達；若是簡體中文，轉為自然的台灣繁體中文
- placeholder 的標籤名稱、id、數量與成對巢狀結構必須逐字保留；可連同它包住的詞語移到自然的中文位置，但不可改變或擴張它包住的語意範圍
- 不要沿用英文在 placeholder、中文標點或中文字之間的多餘空白，也不要為中文與英文、數字或 placeholder 的邊界額外補空格；英文單字內與連續拉丁文字之間仍保留正常空格

輸出契約：
- 只輸出符合 schema 的結果；translations 的每個 key 對應輸入的 segment id
- 不得遺漏、新增、合併或拆分 segment
- 每個 value 只輸出含原有 placeholders 的完整譯文純文字；不要重複 context 或相鄰 segment，不要輸出 Markdown、額外 HTML、code block、說明、前後空白或額外段落。`;

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
		model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
			...CORE_STRUCTURED_MODEL_SETTINGS,
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
		})}`,
		system: ZH_HANT_MARKDOWN_TRANSLATION_SYSTEM_PROMPT,
		output: Output.object({
			name: 'translation_batch',
			description: 'Complete, faithful, naturally edited Taiwan Traditional Chinese prose blocks keyed by exact input segment IDs.',
			schema: zhHantMarkdownTranslationsSchema(group.segments),
		}),
		maxOutputTokens: 8000,
		temperature: 0.2,
		reasoning: 'none',
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Markdown segment translation hit its output token cap');
	return validateMarkdownBatchTranslations(
		{ segments: group.segments },
		group.segments.map(({ id }) => ({ id, text: output.translations[id] ?? '' })),
	);
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
