import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';
import {
	createMarkdownTranslationTemplate,
	createSourceMarkdownSegmentTranslation,
	type MarkdownSegmentTranslation,
	type MarkdownTranslationBatch,
	MarkdownTranslationInvariantError,
	type MarkdownTranslationSegment,
	validateMarkdownBatchTranslations,
} from './markdown-translation';

const markdownTranslationTextPartSchema = z.strictObject({
	type: z.literal('text'),
	value: z.string().min(1),
});

function markdownTranslationPartsSchema(inlineIds: readonly string[]) {
	if (!inlineIds.length) return z.array(markdownTranslationTextPartSchema);
	const markdownTranslationInlinePartSchema = z.strictObject({
		type: z.literal('inline'),
		value: z.enum(inlineIds as [string, ...string[]]),
	});
	return z.array(z.discriminatedUnion('type', [markdownTranslationTextPartSchema, markdownTranslationInlinePartSchema]));
}

function zhHantMarkdownTranslationsSchema(segments: readonly MarkdownTranslationSegment[]) {
	return z.strictObject({
		translations: z
			.strictObject(
				Object.fromEntries(
					segments.map((segment) => {
						const template = createMarkdownTranslationTemplate(segment);
						return [
							segment.id,
							z.strictObject({
								sequences: z.strictObject(
									Object.fromEntries(
										Object.entries(template.sequences).map(([sequenceId, parts]) => {
											const inlineIds = parts.flatMap((part) => (typeof part === 'string' ? [] : [part.id]));
											return [
												sequenceId,
												markdownTranslationPartsSchema(inlineIds).describe(
													inlineIds.length
														? `Translated ${sequenceId}; inline values must be exactly ${inlineIds.join(', ')} once each.`
														: `Translated ${sequenceId}; use text parts only.`,
												),
											];
										}),
									),
								),
							}),
						];
					}),
				),
			)
			.describe('One complete set of translated inline sequences for every input segment ID.'),
	});
}

const ZH_HANT_MARKDOWN_TRANSLATION_SYSTEM_PROMPT = `你是專業的全文翻譯編輯。目標語言是自然、準確、符合台灣讀者習慣的繁體中文。

輸入契約：
- 每個 segment 是一個完整標題、段落、表格儲存格，或超長純文字段落的一個完整句界切片
- sequences 是 Core 劃定的可翻譯範圍；其中 string 是待翻譯原文，{id} 是由 Core 保管、可依中文語序移動的 inline reference
- inlines 以 id 為 key，kind 說明連結、強調、圖片、程式碼、公式或其他 Markdown inline；若同名 sequence 存在，它就是該 container 包住的可見文字，否則是 atom
- sequence key 若以某個 inline id 加上 :slot: 開頭，代表該 container 內被固定結構隔開的一段可見文字；root:slot: 則屬於最外層文字
- raw HTML、hard break、註腳引用與不透明自動連結等固定結構不會出現在輸入；Core 已把它們前後切成不同 sequence，並會在輸出後原位組回
- 同一 segment 的所有 sequences 合起來才是完整句意；context、inline id、kind、reference 都只供翻譯判斷，不屬於譯文

翻譯準則：
- 把同一 segment 當作完整段落理解，不要逐 part 直譯；可以在同一 sequence 內依自然的台灣中文調整語序、拆合子句與重新安排 text parts，但不要把文字移到另一個 sequence
- 維持同一批段落的敘事語氣與術語一致；每個 segment 仍須只翻譯一次並完整輸出，不要重複相鄰 segment 或 context
- 忠實完整翻譯，不要摘要、評論、解釋、補充背景或新增原文沒有的資訊
- 保留原文語氣、時態、否定、程度、條件、不確定性、引述關係、數字、單位與引用指向
- 使用台灣常用詞彙與自然的繁體中文標點；中文敘述通常使用全形的，。；：！？、（）與「」『』，不要機械沿用英文半形標點。URL、email、程式碼、版本號、小數與完整英文片語內的符號仍照原文保留
- 人名、組織、產品和技術術語有通行譯名時採用通行譯名，沒有時保留原文，不要自創譯名或縮寫
- 採用台灣慣用詞，例如「新創公司」、「機車」、「載貨自行車」、「城市移動」；避免「初創」、「摩托車」、「出行」、「貨物自行車」等非台灣慣用詞
- 一般介面與商業詞彙應自然翻譯，不要把 configurator 等非專有名詞無故保留成英文
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然的台灣繁體中文
- 每個 inline id 必須在原本的 sequence 內恰好出現一次，並可在該 sequence 內依中文語序重新排列
- container 的內文只能翻譯在它的同名 sequence；不要把文字移入或移出連結、強調等格式範圍
- 依 reference 判斷 atom 的語意角色，不要把 reference 複製進 text。例如設定名稱與檔案路徑可在 root 中換序，譯成「在」+ 檔案路徑 inline +「中，將選項加入現有的」+ 設定名稱 inline +「值」
- 不要沿用英文在 inline、中文標點或中文字之間的多餘空白，也不要為中文與英文、數字或 inline 邊界額外補空格；英文單字內與連續拉丁文字之間仍保留正常空格

輸出契約：
- 只輸出符合 schema 的結果；translations 的每個 key 對應輸入的 segment id
- 不得遺漏、新增、合併或拆分 segment 或 sequence；每個 sequence key 必須與輸入完全相同
- type=text 的 value 只放譯文純文字；type=inline 的 value 只放該 sequence 原有的 inline id。text parts 可以自由拆合；不需要空 text part
- 不要輸出 Markdown、HTML、XML、內部 token、說明、前後空白或額外段落；整個 segment 與原本含有文字的 sequence 都不可為空。`;

type TranslationRecoveryStrategy = 'batch' | 'halves' | 'individual';

type TranslationGroup = Readonly<{
	index: number;
	segments: readonly MarkdownTranslationSegment[];
	strategy: TranslationRecoveryStrategy;
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
	return groups.map((segments, index) => ({ index: index + 1, segments, strategy }));
}

async function translateGroup(
	group: TranslationGroup,
	batch: MarkdownTranslationBatch,
	env: CoreEnv,
	resourceId: string,
): Promise<readonly MarkdownSegmentTranslation[]> {
	const promptSegments = group.segments.map((segment) => ({
		context: segment.context,
		id: segment.id,
		...createMarkdownTranslationTemplate(segment),
	}));
	const { finishReason, output } = await generateText({
		model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
			...CORE_STRUCTURED_MODEL_SETTINGS,
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					batch_id: batch.id,
					feature: 'resource-content-translation',
					recovery_strategy: group.strategy,
					resource_id: resourceId,
					sub_batch_index: group.index,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt: `${JSON.stringify({
			targetLocale: 'zh-Hant',
			editorialVariant: 'zh-TW',
			segments: promptSegments,
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
		group.segments.map((segment) => ({
			id: segment.id,
			sequences: output.translations[segment.id]?.sequences ?? {},
		})),
	);
}

function isMarkdownOutputContractError(error: unknown): boolean {
	return error instanceof MarkdownTranslationInvariantError || NoObjectGeneratedError.isInstance(error);
}

export async function translateMarkdownBatchToZhHant(
	batch: MarkdownTranslationBatch,
	env: CoreEnv,
	resourceId: string,
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
			try {
				translated.push(...(await translateGroup(group, batch, env, resourceId)));
			} catch (error) {
				const segment = group.segments[0];
				if (group.strategy !== 'individual' || group.segments.length !== 1 || !segment || !isMarkdownOutputContractError(error)) {
					throw error;
				}
				console.warn({
					tag: 'RESOURCE_TRANSLATION',
					event: 'markdown_segment_original_fallback',
					attempt,
					batch_id: batch.id,
					finish_reason: NoObjectGeneratedError.isInstance(error) ? error.finishReason : undefined,
					reason:
						error instanceof MarkdownTranslationInvariantError
							? error.code
							: NoObjectGeneratedError.isInstance(error)
								? error.name
								: 'unknown',
					resource_id: resourceId,
					segment_id: segment.id,
				});
				translated.push(createSourceMarkdownSegmentTranslation(segment));
			}
		}
		return validateMarkdownBatchTranslations(batch, translated);
	} catch (error) {
		console.error({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_batch_attempt_failed',
			attempt,
			batch_id: batch.id,
			message: error instanceof Error ? error.message : String(error),
			reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
			resource_id: resourceId,
		});
		throw error;
	}
}
