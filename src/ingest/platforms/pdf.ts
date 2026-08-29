import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { initSync, LiteParse, type LiteParseInit, type ParseResult } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import liteParsePackage from '@llamaindex/liteparse-wasm/package.json';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { canonicalizeResourceLang, type ResourceCreator, ResourceCreatorsSchema } from '../../shared/resource';
import type { GenericAcquiredMaterial } from './materialize';
import { fetchOpenAlexPdf } from './openalex';
import { LLAMA_PARSE_MAX_PAGES, type PaidPdfFallbackGrant } from './pdf-fallback-policy.ts';
import { stageLlamaParseFallback } from './pdf-llamaparse';
import { usablePdfMarkdown } from './pdf-text';

export const PDF_MIME = 'application/pdf';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PAID_PDF_PAGES = LLAMA_PARSE_MAX_PAGES;
export type { PaidPdfFallbackGrant } from './pdf-fallback-policy.ts';

const MAX_PAPER_IDENTIFIER_TEXT_CHARS = 20_000;

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

type PdfQualityReason = 'complex-layout' | 'empty-batch' | 'garbled-text' | 'needs-ocr' | 'parse-failed' | 'unparsed';
type PdfHardDefect = 'empty-output' | 'garbled-text' | 'needs-ocr' | 'parse-failed' | 'unparsed';

type LocalPdfParseOutcome = Readonly<{
	hardDefects: PdfHardDefect[];
	parserVersion: string;
	status: 'usable' | 'hard-defect';
	totalPages: number | null;
}>;

export type PdfAcquisitionDraft = Readonly<{
	kind: 'local-pdf';
	material: GenericAcquiredMaterial;
	parse: LocalPdfParseOutcome;
}>;

export function isPdfAcquisitionDraft(value: GenericAcquiredMaterial | PdfAcquisitionDraft): value is PdfAcquisitionDraft {
	return 'kind' in value && value.kind === 'local-pdf';
}

type ParsedPdf = Readonly<{
	markdown: string;
	paperIdentifierText: string | null;
	parsedPages: number;
	problemPageCount: number;
	problemPageSample: number[];
	qualityReasons: PdfQualityReason[];
	totalPages: number;
	unparsedPages: number;
}>;

type ParsedPdfAccumulator = {
	coveredPages: Set<number>;
	markdown: string[];
	paperIdentifierText: string | null;
	parsedPages: number;
	problemPages: Set<number>;
	qualityReasons: Set<PdfQualityReason>;
};

type LocalPdfParseResult = Readonly<{
	markdown: string;
	paperIdentifierText: string | null;
	parse: LocalPdfParseOutcome;
}>;

const HARD_PDF_QUALITY_REASONS = new Set<PdfQualityReason>(['garbled-text', 'needs-ocr', 'parse-failed', 'unparsed']);

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
		if (page.pageNum === 1 && usable && accumulator.paperIdentifierText === null) accumulator.paperIdentifierText = usable;
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
		paperIdentifierText: accumulator.paperIdentifierText?.slice(0, MAX_PAPER_IDENTIFIER_TEXT_CHARS) ?? null,
		parsedPages: accumulator.parsedPages,
		problemPageCount: accumulator.problemPages.size + unparsedPages,
		problemPageSample,
		qualityReasons: [...accumulator.qualityReasons].sort(),
		totalPages,
		unparsedPages,
	};
}

function parsedPdfOutcome(parsed: ParsedPdf): LocalPdfParseOutcome {
	const hardDefects: PdfHardDefect[] = [
		...(parsed.markdown ? [] : (['empty-output'] as const)),
		...parsed.qualityReasons.filter((reason): reason is Exclude<PdfHardDefect, 'empty-output'> => HARD_PDF_QUALITY_REASONS.has(reason)),
	];
	return {
		hardDefects,
		parserVersion: liteParsePackage.version,
		status: hardDefects.length ? 'hard-defect' : 'usable',
		totalPages: parsed.totalPages,
	};
}

function failedPdfOutcome(totalPages: number | null): LocalPdfParseOutcome {
	return {
		hardDefects: ['parse-failed'],
		parserVersion: liteParsePackage.version,
		status: 'hard-defect',
		totalPages,
	};
}

async function parsePdfBytes(bytes: Uint8Array, sourceLabel: string): Promise<LocalPdfParseResult> {
	const parser = new LiteParse(LITEPARSE_CONFIG);
	let session: Awaited<ReturnType<LiteParse['openBatchSession']>> | undefined;
	try {
		session = await parser.openBatchSession(bytes);
		const accumulator: ParsedPdfAccumulator = {
			coveredPages: new Set(),
			markdown: [],
			paperIdentifierText: null,
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
		const parse = parsedPdfOutcome(result);
		console.info({
			tag: 'PDF_PARSE',
			event: 'liteparse_completed',
			hard_defects: parse.hardDefects,
			outcome: parse.status,
			parser_version: parse.parserVersion,
			parsed_pages: result.parsedPages,
			problem_page_count: result.problemPageCount,
			problem_page_sample: result.problemPageSample,
			quality_reasons: result.qualityReasons,
			source: sourceLabel,
			total_pages: result.totalPages,
			unparsed_pages: result.unparsedPages,
		});
		return { markdown: result.markdown, paperIdentifierText: result.paperIdentifierText, parse };
	} catch (error) {
		console.error({
			tag: 'PDF_PARSE',
			event: 'liteparse_failed',
			parser_version: liteParsePackage.version,
			source: sourceLabel,
			error: error instanceof Error ? error.message : String(error),
		});
		return { markdown: '', paperIdentifierText: null, parse: failedPdfOutcome(session?.totalPages ?? null) };
	} finally {
		try {
			session?.free();
		} finally {
			parser.free();
		}
	}
}

function requireUsablePdf(acquisition: PdfAcquisitionDraft, sourceLabel: string): GenericAcquiredMaterial {
	if (!acquisition.material.markdown) throw new NonRetryableError(`${sourceLabel} has no usable text; OCR is required`);
	return acquisition.material;
}

/** Finish a direct public PDF after the retrying fetch/local-parse step has ended. */
export async function completeFetchedPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquisition: PdfAcquisitionDraft;
		grant: PaidPdfFallbackGrant | null;
		processingId: string;
		sourceUrl: string;
	},
): Promise<GenericAcquiredMaterial> {
	const cloudMarkdown = await stageLlamaParseFallback(env, step, {
		grant: input.grant,
		local: input.acquisition.parse,
		processingId: input.processingId,
		sourceUrl: input.sourceUrl,
	});
	if (!cloudMarkdown) return requireUsablePdf(input.acquisition, 'Fetched PDF');
	return {
		...input.acquisition.material,
		markdown: cloudMarkdown,
		paperIdentifierText: cloudMarkdown.slice(0, MAX_PAPER_IDENTIFIER_TEXT_CHARS),
		summary: cloudMarkdown.slice(0, 500) || null,
	};
}

type PdfRepresentation = Readonly<{
	fileType: typeof PDF_MIME;
	markdown: string;
	paperIdentifierText: string | null;
}>;

/** OpenAlex content URLs need our API key, so this optional representation is always local-only. */
export async function stageOpenAlexPdfRepresentation(
	env: CoreEnv,
	step: WorkflowStep,
	input: { contentPdfUrl: string; processingId: string },
): Promise<PdfRepresentation | null> {
	try {
		const contentStream = await step.do(
			'acquire-openalex-content-pdf-v6',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const response = await fetchOpenAlexPdf({ apiKey: env.OPENALEX_API_KEY, contentPdfUrl: input.contentPdfUrl });
				return Response.json(await acquireFetchedPdfResponse(response, input.contentPdfUrl)).body!;
			},
		);
		const local = await new Response(contentStream).json<PdfAcquisitionDraft>();
		const acquired = requireUsablePdf(local, 'OpenAlex content PDF');
		console.info({
			tag: 'OPENALEX_CONTENT',
			event: 'pdf_acquired',
			processing_id: input.processingId,
			chars: acquired.markdown.length,
			local_parse_outcome: local.parse.status,
		});
		return {
			fileType: PDF_MIME,
			markdown: acquired.markdown,
			paperIdentifierText: acquired.paperIdentifierText ?? null,
		};
	} catch (error) {
		console.error({
			tag: 'OPENALEX_CONTENT',
			event: 'pdf_acquisition_failed',
			processing_id: input.processingId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

type StoredPdfInput = {
	creators: ResourceCreator[];
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
	id: string;
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
			resource.storage_key
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN sources monitored_source ON monitored_source.id = resource.source_id
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'private'
		  AND resource.kind = 'file'
		  AND resource.file_type = ${PDF_MIME}
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (SELECT 1 FROM user_files file WHERE file.resource_id = resource.id)
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new NonRetryableError(`Failed to fetch stored PDF ${resourceId}: not found or not an owned private blob`);
	const title = row.title?.trim();
	const source = row.source?.trim();
	if (!title) throw new NonRetryableError(`Stored PDF ${resourceId} has no title`);
	if (!source) throw new NonRetryableError(`Stored PDF ${resourceId} has no source`);
	if (!row.storage_key) throw new NonRetryableError(`Stored PDF ${resourceId} has no blob representation`);
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new NonRetryableError('Invalid published_date: expected date');
	let creators: ResourceCreator[];
	try {
		creators = ResourceCreatorsSchema.parse(row.creators);
	} catch (error) {
		throw new NonRetryableError(`Invalid creators for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		creators,
		originalLang: canonicalizeResourceLang(row.original_lang),
		publishedDate: publishedDate?.toISOString() ?? null,
		resourceId: row.id,
		source,
		storageKey: row.storage_key,
		summary: row.summary,
		title,
	};
}

async function acquireStoredPdf(env: CoreEnv, resource: StoredPdfInput): Promise<PdfAcquisitionDraft> {
	const obj = await env.R2.get(resource.storageKey);
	if (!obj) throw new NonRetryableError(`PDF source object missing: ${resource.storageKey}`);
	if (obj.size > MAX_PDF_BYTES) throw new NonRetryableError(`PDF source object exceeded ${MAX_PDF_BYTES} bytes`);
	const sourceLabel = `Stored PDF ${resource.resourceId}`;
	const parsed = await parsePdfBytes(new Uint8Array(await obj.arrayBuffer()), sourceLabel);
	return {
		kind: 'local-pdf',
		material: {
			resourcePlatform: null,
			fileType: PDF_MIME,
			title: resource.title,
			markdown: parsed.markdown,
			paperIdentifierText: parsed.paperIdentifierText,
			source: resource.source,
			originalLang: resource.originalLang,
			publishedDate: resource.publishedDate,
			summary: resource.summary,
			creators: resource.creators,
			kindMetadata: null,
		},
		parse: parsed.parse,
	};
}

export async function acquireFetchedPdfResponse(response: Response, finalUrl: string): Promise<PdfAcquisitionDraft> {
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
	const parsed = await parsePdfBytes(await new Response(body).bytes(), 'Fetched PDF');
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
	if (!title) throw new NonRetryableError(`File name has no title: ${fileName}`);
	const source = new URL(finalUrl).hostname.replace(/^www\./, '');
	return {
		kind: 'local-pdf',
		material: {
			resourcePlatform: null,
			fileType: PDF_MIME,
			title,
			markdown: parsed.markdown,
			paperIdentifierText: parsed.paperIdentifierText,
			source,
			originalLang: null,
			publishedDate: null,
			summary: parsed.markdown.slice(0, 500) || null,
			creators: [],
			kindMetadata: null,
		},
		parse: parsed.parse,
	};
}

export async function stageStoredPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	target: Readonly<{ resourceId: string }>,
): Promise<GenericAcquiredMaterial> {
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
		'acquire-stored-pdf-v5',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await acquireStoredPdf(env, resource)).body!,
	);
	const acquisition = await new Response(contentStream).json<PdfAcquisitionDraft>();
	return requireUsablePdf(acquisition, `Stored PDF ${target.resourceId}`);
}
