import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';
import {
	createMarkdownTranslationTemplate,
	type MarkdownSegmentTranslation,
	type MarkdownTranslationBatch,
	MarkdownTranslationInvariantError,
	type MarkdownTranslationSegment,
	validateMarkdownBatchTranslations,
} from './markdown-translation';

function markdownTranslationSequenceSchema(partIds: readonly string[]) {
	if (!partIds.length) return z.array(z.string()).max(0);
	return z
		.array(z.enum(partIds as [string, ...string[]]))
		.length(partIds.length)
		.describe(`The same IDs exactly once, in natural target-language order: ${partIds.join(', ')}`);
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
								texts: z.strictObject(
									Object.fromEntries(
										Object.keys(template.texts).map((textId) => [textId, z.string().describe(`Translation of ${textId}.`)]),
									),
								),
								sequences: z.strictObject(
									Object.fromEntries(
										Object.entries(template.sequences).map(([sequenceId, partIds]) => [
											sequenceId,
											markdownTranslationSequenceSchema(partIds),
										]),
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

const ZH_HANT_MARKDOWN_TRANSLATION_SYSTEM_PROMPT = `你是專業的全文翻譯編輯。請產出自然、準確、符合台灣讀者習慣的繁體中文。

翻譯準則：
- 先把同一 segment 的所有 texts 當作一個完整標題、段落或表格儲存格理解，再依各 t ID 完整翻譯；不要逐字直譯
- 維持同一批段落的敘事語氣與術語一致，不要重複相鄰 segment 或 context
- 忠實完整翻譯，不要摘要、評論、解釋、補充背景或新增原文沒有的資訊
- 保留原文語氣、時態、否定、程度、條件、不確定性、引述關係、數字、單位與引用指向
- 使用台灣常用詞彙與自然的繁體中文標點；中文敘述通常使用全形的，。；：！？、（）與「」『』，不要機械沿用英文半形標點。URL、email、程式碼、版本號、小數與完整英文片語內的符號仍照原文保留
- 人名、組織、產品和技術術語有通行譯名時採用通行譯名，沒有時保留原文，不要自創譯名或縮寫
- 採用台灣慣用詞，例如「新創公司」、「機車」、「載貨自行車」、「城市移動」；避免「初創」、「摩托車」、「出行」、「貨物自行車」等非台灣慣用詞
- 一般介面與商業詞彙應自然翻譯，不要把 configurator 等非專有名詞無故保留成英文
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然的台灣繁體中文

格式契約：
- texts 的每個 t ID 都是固定的翻譯位置；只把該 key 的原文翻譯回同一 key，不得把正文移到其他 t ID
- sequences 只描述排版順序。每個 sequence 必須保留輸入中的同一組 t 與 n ID，各恰好一次；可在同一 sequence 內依中文語序換序，但不得跨 sequence 移動
- n ID 是 Core 保管的連結、強調、圖片、程式碼、公式或其他 inline。reference 只供理解，不能複製成譯文；不要把正文移入或移出 n ID 所屬的格式範圍
- 不要沿用英文在 inline、中文標點或中文字之間的多餘空白，也不要為中文與英文、數字或 inline 邊界額外補空格；英文單字內與連續拉丁文字之間仍保留正常空格
- 只輸出符合 schema 的結果；不得遺漏或新增 segment、text、sequence 或 ID
- texts 的 value 只放譯文純文字，不要輸出 Markdown、HTML、XML、ID、說明、前後空白或額外段落。`;

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
			texts: output.translations[segment.id]?.texts ?? {},
		})),
	);
}

function structuredOutputFailure(error: unknown): Record<string, unknown> {
	if (!NoObjectGeneratedError.isInstance(error)) return {};
	return {
		cause: error.cause instanceof Error ? error.cause.message : undefined,
		finish_reason: error.finishReason,
		generated_text_characters: error.text?.length,
		response_id: error.response?.id,
	};
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
				const segment = group.strategy === 'individual' && group.segments.length === 1 ? group.segments[0] : null;
				if (segment) {
					console.error({
						tag: 'RESOURCE_TRANSLATION',
						event: 'markdown_segment_translation_failed',
						attempt,
						batch_id: batch.id,
						reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
						resource_id: resourceId,
						segment_id: segment.id,
						...structuredOutputFailure(error),
					});
				}
				throw error;
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
			...structuredOutputFailure(error),
		});
		throw error;
	}
}
