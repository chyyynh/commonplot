import { hash } from 'node:crypto';
import { createResourceTask, enqueueSearchProgress, type ResourceTask, type ResourceTaskContext } from './progress';
// Durable translation execution; resource processing only enqueues this Workflow.
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { type WorkflowDynamicDelayContext, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import type { ResourceKind, ResourcePlatform } from '../shared/resource';
import { coreGatewayOptions, CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';
import {
	compileMarkdownTranslationArtifact,
	type MarkdownSegmentTranslation,
	type MarkdownTranslationBatch,
	MarkdownTranslationInvariantError,
	type MarkdownTranslationSegment,
	planMarkdownTranslation,
	validateMarkdownBatchTranslations,
} from './markdown-translation';
import { PDF_MIME } from './platforms/pdf-policy';

const TRANSLATABLE_RESOURCE_KINDS = ['blog', 'forum', 'post', 'paper'] as const;

type ResourceTranslationCandidate = Readonly<{
	fileType: string | null;
	kind: ResourceKind;
	originalLang: string;
	resourcePlatform: ResourcePlatform | null;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

export function shouldEnqueueResourceTranslation(candidate: ResourceTranslationCandidate): boolean {
	const privateUploadedPdf =
		candidate.fileType === PDF_MIME &&
		candidate.resourcePlatform === null &&
		candidate.scope === 'private' &&
		candidate.kind === 'file' &&
		candidate.url === null;
	if (privateUploadedPdf) return candidate.originalLang !== 'zh-Hant';
	return (
		candidate.originalLang !== 'zh-Hant' &&
		candidate.scope === 'corpus' &&
		Boolean(candidate.url) &&
		(TRANSLATABLE_RESOURCE_KINDS as readonly string[]).includes(candidate.kind) &&
		(candidate.fileType !== PDF_MIME || (candidate.kind === 'paper' && candidate.resourcePlatform === null))
	);
}

type ResourceTranslationPayload = { force?: boolean; resourceId: string; translationRevision: string };
const ResourceTranslationSourceSchema = z.enum(['original', 'machine', 'human']);

type ResourceTranslationInput = ResourceTranslationCandidate & {
	id: string;
	title: string;
	summary: string | null;
	content: string;
	zhHantTranslation: {
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
	zh_hant_source: string | null;
	translation_revision: string;
	url: string | null;
};

const MARKDOWN_TRANSLATION_CONCURRENCY = 15;
const AI_RATE_LIMIT_ERROR = /\b(?:3021|3040|429)\b|rate limit|too many requests|capacity temporarily exceeded/iu;

function translationRetryDelay({ ctx, error }: WorkflowDynamicDelayContext): number {
	// Delay already scales with attempt; use constant Workflow backoff to avoid multiplying it again.
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
		content: force || isBlank(translation?.content),
	};
}

function zhHantMarkdownTranslationsSchema(segments: readonly MarkdownTranslationSegment[]) {
	return z.strictObject({
		translations: z
			.strictObject(
				Object.fromEntries(
					segments.map(({ id, template }) => {
						const requiredTextIds = new Set(
							Object.values(template.sequences).flatMap((partIds) => {
								const textIds = partIds.filter((id) => Object.hasOwn(template.texts, id));
								return textIds.length === 1 && /[\p{L}\p{N}]/u.test(template.texts[textIds[0]!] ?? '') ? textIds : [];
							}),
						);
						return [
							id,
							z.strictObject({
								texts: z.strictObject(
									Object.fromEntries(
										Object.keys(template.texts).map((id) => {
											const text = z.string();
											return [id, requiredTextIds.has(id) ? text.min(1) : text];
										}),
									),
								),
							}),
						];
					}),
				),
			)
			.describe('One complete set of translated text slots for every input segment ID.'),
	});
}

function markdownTranslationModelInput({ id, context, template }: MarkdownTranslationSegment) {
	return {
		context,
		id,
		sequences: Object.fromEntries(
			Object.entries(template.sequences).map(([sequenceId, partIds]) => [
				sequenceId,
				partIds.map((partId) =>
					Object.hasOwn(template.texts, partId)
						? { id: partId, text: template.texts[partId] }
						: { id: partId, inline: template.inlines[partId] },
				),
			]),
		),
	};
}

const ZH_HANT_MARKDOWN_TRANSLATION_SYSTEM_PROMPT = `你是專業的全文翻譯編輯。請產出自然、準確、符合台灣讀者習慣的繁體中文。

輸入契約：
- 每個 segment 是一個完整標題、段落、表格儲存格，或超長純文字段落的一個完整句界切片
- sequences 直接列出各個語意範圍內的原始排列；{ id: t, text } 是可寫入譯文的位置，{ id: n, inline } 是受保護的 inline
- t ID 是 inline 前後可寫入譯文的位置，不是一對一翻譯單位；n ID 是 Core 保管的連結、強調、圖片、程式碼、公式或其他 Markdown inline
- 若某個 n ID 也有同名 sequence，該 sequence 是該 container 內的可見文字；同一 segment 的所有 sequences 合起來才是完整句意
- context、ID、kind 與 reference 只供翻譯判斷，不屬於譯文

翻譯準則：
- 把同一 segment 當作完整段落理解，不要逐 t ID 直譯
- 在同一 sequence 內，把完整譯文自然分配到既有 t 位置；可以合併、拆分或把內容移到同一 sequence 的另一個 t，沒有譯文的 t 回傳空字串
- 不得把正文移到另一個 sequence；sequence 是連結、強調等格式作用範圍的邊界
- 英文冠詞、空白等不需要一一產生中文表面文字；但不要把正文移入或移出 n ID 所屬的 container
- 維持同一批段落的敘事語氣與術語一致，不要重複相鄰 segment 或 context
- 忠實完整翻譯，不要摘要、評論、解釋、補充背景或新增原文沒有的資訊
- 網址與 email 保留原文的字元和間隔，不要修復或補上網址；包含空格的網址也照原樣保留
- 保留原文語氣、時態、否定、程度、條件、不確定性、引述關係、數字、單位與引用指向
- 使用台灣常用詞彙與自然的繁體中文標點；中文敘述通常使用全形的，。；：！？、（）與「」『』，不要機械沿用英文半形標點。URL、email、程式碼、版本號、小數與完整英文片語內的符號仍照原文保留
- 人名、組織、產品和技術術語有通行譯名時採用通行譯名，沒有時保留原文，不要自創譯名或縮寫
- 採用台灣慣用詞，例如「新創公司」、「機車」、「載貨自行車」、「城市移動」；避免「初創」、「摩托車」、「出行」、「貨物自行車」等非台灣慣用詞
- 一般介面與商業詞彙應自然翻譯，不要把 configurator 等非專有名詞無故保留成英文
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然的台灣繁體中文

格式契約：
- translations 的每個 key 對應輸入的 segment ID；每個 segment 只輸出 texts，包含該 segment 所有 sequences 的 t ID，不要輸出 sequence ID 或 n ID
- 每個 t value 只放該位置的譯文純文字，可以是空字串；不要把 n ID、sequence、reference、Markdown 或 HTML 寫進 t value
- n ID 的次序、數量與結構完全由 Core 還原，不能也不需要在輸出中重複
- reference 只供理解，不能複製成譯文；URL、Markdown 語法和其他受保護內容由 Core 還原
- 不要沿用英文在 inline、中文標點或中文字之間的多餘空白，也不要為中文與英文、數字或 inline 邊界額外補空格；英文單字內與連續拉丁文字之間仍保留正常空格
- 只輸出符合 schema 的結果，不要輸出說明或額外段落；整個 segment 的正文不可全數刪除。若 t 是某個 sequence 唯一的文字位置，schema 會要求它非空；專有名詞、產品名或單一字母若不需翻譯，請照原文保留。`;

function splitSegmentsInHalf(segments: readonly MarkdownTranslationSegment[]): readonly (readonly MarkdownTranslationSegment[])[] {
	if (segments.length <= 1) return [segments];
	const totalCharacters = segments.reduce((total, segment) => total + segment.characterCount + (segment.context?.length ?? 0), 0);
	const targetCharacters = totalCharacters / 2;
	let consumedCharacters = 0;
	let splitIndex = 1;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index]!;
		consumedCharacters += segment.characterCount + (segment.context?.length ?? 0);
		splitIndex = index + 1;
		if (consumedCharacters >= targetCharacters) break;
	}
	return [segments.slice(0, splitIndex), segments.slice(splitIndex)];
}

/** Only malformed model output should split; transport/capacity failures retry the same durable group. */
function isMarkdownTranslationFormatError(error: unknown): boolean {
	return NoObjectGeneratedError.isInstance(error) || (error instanceof MarkdownTranslationInvariantError && error.code !== 'invalid-plan');
}

async function translateMarkdownBatchToZhHant(
	batch: MarkdownTranslationBatch,
	env: CoreEnv,
	resourceId: string,
): Promise<readonly MarkdownSegmentTranslation[]> {
	try {
		const promptSegments = batch.segments.map(markdownTranslationModelInput);
		const { finishReason, output } = await generateText({
			model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
				...CORE_STRUCTURED_MODEL_SETTINGS,
				...coreGatewayOptions(env, {
					batch_id: batch.id,
					feature: 'resource-content-translation',
					recovery_strategy: batch.id.includes('-') ? 'split' : 'batch',
					resource_id: resourceId,
				}),
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
				schema: zhHantMarkdownTranslationsSchema(batch.segments),
			}),
			maxOutputTokens: 12000,
			temperature: 0.2,
			reasoning: 'none',
			maxRetries: 0,
		});
		if (finishReason === 'length')
			throw new MarkdownTranslationInvariantError('invalid-result', 'Markdown segment translation hit its output token cap');
		return validateMarkdownBatchTranslations(
			batch,
			batch.segments.map(({ id }) => output.translations[id]!),
		);
	} catch (error) {
		console.error({
			tag: 'RESOURCE_TRANSLATION',
			event: 'markdown_batch_attempt_failed',
			batch_id: batch.id,
			message: error instanceof Error ? error.message : String(error),
			reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
			resource_id: resourceId,
			...(NoObjectGeneratedError.isInstance(error)
				? {
						cause: error.cause instanceof Error ? error.cause.message : undefined,
						finish_reason: error.finishReason,
						generated_text_characters: error.text?.length,
						response_id: error.response?.id,
					}
				: {}),
		});
		throw error;
	}
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
		`translate-zh-hant-markdown-${batch.id}-v17`,
		{ retries: { limit: 3, delay: translationRetryDelay, backoff: 'constant' }, timeout: '300 seconds' },
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
		aligned_blocks: translated.alignment.paths.length,
		translated_characters: translated.content.length,
	});
	return translated;
}

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v33';
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
			originalLang: row.original_lang,
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
			resource_id, lang, title, summary, content, alignment, source, updated_at
		)
		SELECT
			target_resource.id, 'zh-Hant', ${patch.title ?? null}, ${patch.summary ?? null}, ${patch.content ?? null},
			${patch.alignment === undefined ? null : JSON.stringify(patch.alignment)}::jsonb,
			'machine', NOW()
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = COALESCE(EXCLUDED.title, current_translation.title),
			summary = COALESCE(EXCLUDED.summary, current_translation.summary),
			content = COALESCE(EXCLUDED.content, current_translation.content),
			alignment = COALESCE(EXCLUDED.alignment, current_translation.alignment),
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
		id = `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-retry-${resourceId}-${hash('sha256', id, 'hex').slice(0, 16)}`;
	}
	throw new Error('Translation retry limit reached');
}

// Normal ingestion dedupes by source revision. Explicit reacquisition supplies a deterministic run key so every operator resync
// receives a fresh instance while retries of the same processing Workflow remain idempotent.
export async function enqueueResourceTranslation(
	env: CoreEnv,
	resourceId: string,
	translationRevision: string,
	forceRunKey: string | undefined,
	parent: ResourceTaskContext,
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
		...(parent.required ? { parentTaskId: parent.taskId } : {}),
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
		let followupFailed = false;
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

			const [metadata, content] = await Promise.allSettled([
				translationPlan.metadata
					? step.do(
							'translate-zh-hant-title-summary-v3',
							{ retries: { limit: 5, delay: translationRetryDelay, backoff: 'constant' }, timeout: '180 seconds' },
							() => translateResourceMetadata(resource, this.env),
						)
					: undefined,
				translationPlan.content ? translatePlannedContent(resource.content, this.env, resourceId, step, task) : undefined,
			]);
			if (content.status === 'rejected') {
				const error = content.reason;
				console.error({
					tag: 'RESOURCE_TRANSLATION',
					event: 'content_translation_outcome',
					outcome: 'failed',
					reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
					error: error instanceof Error ? error.message : String(error),
					resource_id: resourceId,
				});
			}
			if (metadata.status === 'rejected') throw metadata.reason;
			if (content.status === 'rejected') throw content.reason;
			const patch: MachineZhHantTranslationPatch = { ...metadata.value, ...content.value };

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
			const followups = await Promise.allSettled([
				task.report('complete', { stage: 'translating', status: 'complete', resourceId }),
				resource.scope === 'corpus'
					? step.do(
							'enqueue-translated-ai-search-sync-v1',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							() => enqueueSearchProgress(this.env, resourceId, task, `${translationRevision}-zh-hant`),
						)
					: undefined,
			]);
			const failures = followups.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
			if (failures.length) throw new AggregateError(failures, 'Translation persisted, but follow-ups failed');
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Completed', resource_id: resourceId, scope: resource.scope });
			return { status: 'complete', resourceId };
		} catch (error) {
			followupFailed = translationPublished;
			await task.report('outcome-after-error', {
				status: translationPublished ? 'complete' : 'failed',
				resourceId,
				...(translationPublished ? {} : { errorCode: 'translation_failed' }),
			});
			if (translationPublished) {
				console.error({ tag: 'RESOURCE_TRANSLATION', event: 'followup_dispatch_failed', resource_id: resourceId, error });
			}
			throw error;
		} finally {
			await task.seal(followupFailed ? 'followup_dispatch_failed' : undefined);
		}
	}
}
