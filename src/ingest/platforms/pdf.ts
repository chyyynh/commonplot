import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { initSync, LiteParse, type LiteParseInit, type ParseResult } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import liteParsePackage from '@llamaindex/liteparse-wasm/package.json';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { canonicalPaperUrl, paperIdentityFromIdentifiers } from '../../shared/paper-identity';
import {
	canonicalizeResourceLang,
	isPaperIdentifier,
	RESOURCE_TYPES,
	type ResourceCreator,
	ResourceCreatorsSchema,
	type ResourceKindMetadata,
} from '../../shared/resource';
import type { GenericAcquiredMaterial, ResolvedResource } from './materialize';

export const PDF_MIME = 'application/pdf';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PDF_TRANSLATION_CHUNK_MAX_LENGTH = 12_000;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const SYMBOL_OR_PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;

const LITEPARSE_CONFIG = {
	continueOnPageError: true,
	extractBlocks: false,
	imageMode: 'off',
	includeComplexity: true,
	ocrEnabled: false,
	outputFormat: 'markdown',
	quiet: true,
} satisfies LiteParseInit;

initSync({ module: wasmModule });

type ParsedPdf = Readonly<{
	markdown: string;
	parsedPages: number;
	problemPageCount: number;
	problemPageSample: number[];
	qualityReasons: string[];
	totalPages: number;
	unparsedPages: number;
}>;

type ParsedPdfAccumulator = {
	coveredPages: Set<number>;
	markdown: string[];
	parsedPages: number;
	problemPages: Set<number>;
	qualityReasons: Set<string>;
};

type PrivatePdfTranslationCandidate = Readonly<{
	fileType: string | null;
	kind: string;
	resourcePlatform: string | null;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

export type PdfTranslationChunk = Readonly<{ index: number; total: number }>;
export type PdfTranslationAdmission = 'not-pdf' | 'private-upload' | 'unsupported';

export function isPrivateUploadedPdfTranslation(candidate: PrivatePdfTranslationCandidate): boolean {
	return (
		candidate.scope === 'private' &&
		candidate.kind === 'blog' &&
		candidate.resourcePlatform === null &&
		candidate.fileType === PDF_MIME &&
		candidate.url === null
	);
}

export function pdfTranslationAdmission(candidate: PrivatePdfTranslationCandidate): PdfTranslationAdmission {
	if (candidate.fileType !== PDF_MIME || candidate.resourcePlatform !== null) return 'not-pdf';
	return isPrivateUploadedPdfTranslation(candidate) ? 'private-upload' : 'unsupported';
}

export function privateUploadedPdfTranslationSqlAdmission() {
	return sql`(
		resource.scope = 'private'
		AND resource.kind = 'blog'
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

function isUnsafePdfTextCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0);
	return (
		codePoint === 0xfffd ||
		codePoint === 0x0b ||
		codePoint === 0x0c ||
		(codePoint !== undefined && (codePoint <= 0x08 || (codePoint >= 0x0e && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)))
	);
}

/** Drop decoded PDF stream garbage without rejecting ordinary prose, code, or equations. */
function usablePdfMarkdown(markdown: string, parserMarkedGarbled: boolean): string {
	let clean = '';
	let checked = 0;
	let unsafe = 0;
	let significant = 0;
	let symbols = 0;
	let run = 0;
	let longestRun = 0;
	for (const character of markdown) {
		checked++;
		if (isUnsafePdfTextCharacter(character)) {
			unsafe++;
			continue;
		}
		clean += character;
		if (WHITESPACE.test(character)) {
			run = 0;
			continue;
		}
		run++;
		longestRun = Math.max(longestRun, run);
		if (LETTER_OR_NUMBER.test(character)) significant++;
		else if (SYMBOL_OR_PUNCTUATION.test(character)) {
			significant++;
			symbols++;
		}
	}
	const unsafeGarbage = unsafe >= 3 && unsafe / Math.max(1, checked) >= 0.002;
	const printableGarbage = significant >= 256 && symbols / significant >= 0.45 && longestRun >= 80;
	if (parserMarkedGarbled || unsafeGarbage || printableGarbage) return '';
	clean = clean.trim();
	return LETTER_OR_NUMBER.test(clean) ? clean : '';
}

function accumulateLiteParseResult(accumulator: ParsedPdfAccumulator, result: ParseResult): void {
	for (const page of result.pages) {
		accumulator.coveredPages.add(page.pageNum);
		accumulator.parsedPages++;
		const complexity = page.complexity;
		if (complexity?.needsOcr) {
			accumulator.problemPages.add(page.pageNum);
			accumulator.qualityReasons.add('needs-ocr');
		}
		if (complexity?.isGarbled) {
			accumulator.problemPages.add(page.pageNum);
			accumulator.qualityReasons.add('garbled-text');
		}
		if (complexity?.layout?.isComplex) {
			accumulator.problemPages.add(page.pageNum);
			accumulator.qualityReasons.add('complex-layout');
		}
		const usable = usablePdfMarkdown(page.markdown, complexity?.isGarbled ?? false);
		if (usable) accumulator.markdown.push(usable);
		else if (page.markdown.trim()) {
			accumulator.problemPages.add(page.pageNum);
			accumulator.qualityReasons.add('garbled-text');
		}
	}
	for (const error of result.pageErrors) {
		accumulator.coveredPages.add(error.pageNum);
		accumulator.problemPages.add(error.pageNum);
		accumulator.qualityReasons.add('parse-failed');
	}
	if (result.pages.length === 0 && result.pageErrors.length === 0) {
		accumulator.qualityReasons.add('empty-batch');
	}
}

function finishParsedPdf(accumulator: ParsedPdfAccumulator, totalPages: number): ParsedPdf {
	if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error('LiteParse returned an invalid total page count');
	const unparsedPages = Math.max(0, totalPages - accumulator.coveredPages.size);
	if (unparsedPages) accumulator.qualityReasons.add('unparsed');
	const problemPageSample = [...accumulator.problemPages].sort((left, right) => left - right).slice(0, 20);
	for (let pageNumber = 1; pageNumber <= totalPages && problemPageSample.length < 20; pageNumber++) {
		if (!accumulator.coveredPages.has(pageNumber)) problemPageSample.push(pageNumber);
	}
	return {
		markdown: accumulator.markdown.join('\n\n').trim(),
		parsedPages: accumulator.parsedPages,
		problemPageCount: accumulator.problemPages.size + unparsedPages,
		problemPageSample,
		qualityReasons: [...accumulator.qualityReasons].sort(),
		totalPages,
		unparsedPages,
	};
}

async function parsePdfBytes(bytes: Uint8Array, sourceLabel: string): Promise<string> {
	const parser = new LiteParse(LITEPARSE_CONFIG);
	let session: Awaited<ReturnType<LiteParse['openBatchSession']>> | undefined;
	try {
		session = await parser.openBatchSession(bytes);
		const accumulator: ParsedPdfAccumulator = {
			coveredPages: new Set(),
			markdown: [],
			parsedPages: 0,
			problemPages: new Set(),
			qualityReasons: new Set(),
		};
		for (;;) {
			const batch = await session.nextBatch();
			if (!batch) break;
			accumulateLiteParseResult(accumulator, batch.result);
		}
		const result = finishParsedPdf(accumulator, session.totalPages);
		console.info({
			tag: 'PDF_PARSE',
			event: 'liteparse_completed',
			parser_version: liteParsePackage.version,
			parsed_pages: result.parsedPages,
			problem_page_count: result.problemPageCount,
			problem_page_sample: result.problemPageSample,
			quality_reasons: result.qualityReasons,
			source: sourceLabel,
			total_pages: result.totalPages,
			unparsed_pages: result.unparsedPages,
		});
		if (!result.markdown) throw new NonRetryableError(`${sourceLabel} has no usable text; OCR is required`);
		return result.markdown;
	} finally {
		try {
			session?.free();
		} finally {
			parser.free();
		}
	}
}

function splitPdfMarkdownForTranslation(markdown: string, maxLength = PDF_TRANSLATION_CHUNK_MAX_LENGTH): string[] {
	let remaining = markdown.trim();
	if (!remaining) return [];
	const chunks: string[] = [];
	const minimumBoundary = Math.floor(maxLength * 0.9);
	const separators = ['\n\n', '\n', '. ', '。', '！', '？', '; ', '；', ', ', '，', ' '] as const;
	while (remaining.length > maxLength) {
		let end = maxLength;
		let consumedSeparator = 0;
		for (const separator of separators) {
			const boundary = remaining.lastIndexOf(separator, maxLength - separator.length);
			if (boundary < minimumBoundary) continue;
			end = boundary + (separator.trim() ? separator.length : 0);
			consumedSeparator = separator.trim() ? 0 : separator.length;
			break;
		}
		chunks.push(remaining.slice(0, end).trim());
		remaining = remaining.slice(end + consumedSeparator).trimStart();
	}
	if (remaining) chunks.push(remaining.trimEnd());
	return chunks;
}

/**
 * PDF owns its page-derived Markdown chunk boundaries and durable step names.
 * The generic translation Workflow supplies only the language-model operation.
 */
export async function stagePrivatePdfMarkdownTranslation(
	step: WorkflowStep,
	markdown: string,
	translate: (markdownChunk: string, chunk: PdfTranslationChunk) => Promise<string>,
): Promise<string> {
	const chunks = splitPdfMarkdownForTranslation(markdown);
	const translated: string[] = [];
	for (const [index, markdownChunk] of chunks.entries()) {
		const chunk = { index: index + 1, total: chunks.length };
		translated.push(
			await step.do(
				`translate-private-pdf-zh-hant-${String(chunk.index).padStart(4, '0')}-of-${String(chunk.total).padStart(4, '0')}-v2`,
				{ retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				() => translate(markdownChunk, chunk),
			),
		);
	}
	return translated.join('\n\n');
}

type StoredPdfInput = {
	creators: ResourceCreator[];
	fileType: string;
	kindMetadata: ResourceKindMetadata | null;
	originalLang: string;
	publishedDate: string | null;
	resourceId: string;
	source: string;
	storageKey: string;
	summary: string | null;
	title: string;
};

type StoredPdfRow = {
	creators: unknown;
	file_type: string | null;
	id: string;
	kind: keyof typeof RESOURCE_TYPES;
	kind_metadata: unknown;
	original_lang: string;
	published_date: Date | string | null;
	source: string | null;
	storage_key: string | null;
	summary: string | null;
	title: string | null;
};

async function loadStoredPdfInput(db: NodePgDatabase, resourceId: string): Promise<StoredPdfInput> {
	const result = await db.execute<StoredPdfRow>(sql`
		SELECT
			resource.id::text AS id,
			resource.kind,
			original.title,
			original.summary,
			resource.original_lang,
			COALESCE(
				NULLIF(BTRIM(monitored_source.name), ''),
				NULLIF(BTRIM(COALESCE(
					resource.creators->0->>'literal',
					CONCAT_WS(' ', resource.creators->0->>'given', resource.creators->0->>'family')
				)), ''),
				CASE resource.resource_platform
					WHEN 'twitter' THEN 'Twitter'
					WHEN 'youtube' THEN 'YouTube'
					WHEN 'hackernews' THEN 'Hacker News'
					WHEN 'lesswrong' THEN 'LessWrong'
				END,
				INITCAP(resource.kind)
			) AS source,
			resource.published_date,
			resource.creators,
			resource.kind_metadata,
			resource.storage_key,
			resource.file_type
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN sources monitored_source ON monitored_source.id = resource.source_id
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'private'
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (SELECT 1 FROM user_files file WHERE file.resource_id = resource.id)
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch stored PDF ${resourceId}: not found or not an owned private blob`);
	const title = row.title?.trim();
	const source = row.source?.trim();
	if (!title) throw new Error(`Stored PDF ${resourceId} has no title`);
	if (!source) throw new Error(`Stored PDF ${resourceId} has no source`);
	if (!row.storage_key || !row.file_type) throw new Error(`Stored PDF ${resourceId} has no blob representation`);
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new Error('Invalid published_date: expected date');
	let creators: ResourceCreator[];
	try {
		creators = ResourceCreatorsSchema.parse(row.creators);
	} catch (error) {
		throw new Error(`Invalid creators for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		creators,
		fileType: row.file_type,
		kindMetadata: RESOURCE_TYPES[row.kind].metadata.parse(row.kind_metadata),
		originalLang: canonicalizeResourceLang(row.original_lang),
		publishedDate: publishedDate?.toISOString() ?? null,
		resourceId: row.id,
		source,
		storageKey: row.storage_key,
		summary: row.summary,
		title,
	};
}

type StoredPdfAcquisition = Readonly<{
	material: GenericAcquiredMaterial;
	resource: StoredPdfInput;
}>;

async function acquireStoredPdf(env: CoreEnv, resource: StoredPdfInput): Promise<GenericAcquiredMaterial> {
	if (resource.fileType !== PDF_MIME) {
		throw new Error(`Stored resource ${resource.resourceId} is not an R2 PDF`);
	}
	const obj = await env.R2.get(resource.storageKey);
	if (!obj) throw new Error(`PDF source object missing: ${resource.storageKey}`);
	if (obj.size > MAX_PDF_BYTES) throw new Error(`PDF source object exceeded ${MAX_PDF_BYTES} bytes`);
	const markdown = await parsePdfBytes(new Uint8Array(await obj.arrayBuffer()), `Stored PDF ${resource.resourceId}`);
	return {
		resourcePlatform: null,
		fileType: PDF_MIME,
		title: resource.title,
		markdown,
		source: resource.source,
		originalLang: resource.originalLang,
		publishedDate: resource.publishedDate,
		summary: resource.summary,
		creators: resource.creators,
		kindMetadata: resource.kindMetadata,
	};
}

export async function acquireFetchedPdfResponse(response: Response, finalUrl: string): Promise<GenericAcquiredMaterial> {
	let pdfBytes = 0;
	const body = response.body?.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pdfBytes += chunk.byteLength;
				if (pdfBytes > MAX_PDF_BYTES) throw new NonRetryableError(`PDF exceeded ${MAX_PDF_BYTES} bytes`);
				controller.enqueue(chunk);
			},
		}),
	);
	const markdown = await parsePdfBytes(await new Response(body).bytes(), 'Fetched PDF');
	const encodedName = new URL(finalUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
	let fileName = encodedName || 'document.pdf';
	if (encodedName) {
		try {
			fileName = decodeURIComponent(encodedName) || 'document.pdf';
		} catch {
			fileName = encodedName;
		}
	}
	const title = fileName.replace(/\.[a-z0-9]+$/i, '').trim();
	if (!title) throw new Error(`File name has no title: ${fileName}`);
	const source = new URL(finalUrl).hostname.replace(/^www\./, '');
	return {
		resourcePlatform: null,
		fileType: PDF_MIME,
		title,
		markdown,
		source,
		originalLang: null,
		publishedDate: null,
		summary: markdown.slice(0, 500) || null,
		creators: [],
		kindMetadata: { siteName: source },
	};
}

export async function stageStoredPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	target: Readonly<{ resourceId: string }>,
): Promise<StoredPdfAcquisition> {
	const resource = await step.do(
		'load-stored-pdf-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadStoredPdfInput(await connectCoreDb(env), target.resourceId),
		{
			rollback: async () => {
				await env.APP.markStoredBlobProcessingFailed(target.resourceId);
			},
			rollbackConfig: {
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
		},
	);
	const contentStream = await step.do(
		'acquire-stored-pdf-v3',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await acquireStoredPdf(env, resource)).body!,
	);
	return {
		material: await new Response(contentStream).json<GenericAcquiredMaterial>(),
		resource,
	};
}

export function storedPdfProcessingResult(resource: ResolvedResource, input: { resourceId: string }) {
	if (resource.kind !== 'paper') {
		return {
			resource,
			persistenceTarget: { kind: 'existing' as const, resourceId: input.resourceId },
			saveTarget: null,
		};
	}
	const identity = paperIdentityFromIdentifiers(resource.resourceIdentifiers.filter(isPaperIdentifier));
	if (!identity) throw new Error(`Private paper processing ${input.resourceId} has no canonical identity`);
	const url = canonicalPaperUrl(identity);
	return {
		resource: { ...resource, url, normalizedUrl: url },
		persistenceTarget: {
			kind: 'draft' as const,
		},
		saveTarget: { kind: 'userFilePaper' as const, fileResourceId: input.resourceId },
	};
}
