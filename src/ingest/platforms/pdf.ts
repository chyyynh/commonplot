import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { initSync, LiteParse, type LiteParseInit, type ParseBatch } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import liteParsePackage from '@llamaindex/liteparse-wasm/package.json';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { canonicalizeResourceLang, type ResourceCreator, ResourceCreatorsSchema } from '../../shared/resource';
import { GROBID_CONTAINER_NAME } from '../grobid-container';
import { type GrobidPdfHeader, grobidPaperIdentifierText } from '../grobid-tei';
import { type GenericAcquiredMaterial, literalCreator } from './materialize';
import { fetchOpenAlexPdf } from './openalex';
import { MAX_PDF_BYTES, PDF_MIME } from './pdf-constants';
import { type LocalPdfSummary, localPdfNeedsFallback, type PaidPdfFallbackGrant, storageSafePdfMarkdown } from './pdf-fallback-policy.ts';
import { stagePaidLlamaParseFallback } from './pdf-llamaparse';

export { PDF_MIME } from './pdf-constants';
export type { PaidPdfFallbackGrant } from './pdf-fallback-policy.ts';

const MAX_PAPER_IDENTIFIER_TEXT_CHARS = 20_000;
const GROBID_HEADER_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '600 seconds' } as const;

const LITEPARSE_CONFIG = {
	continueOnPageError: true,
	imageMode: 'off',
	includeComplexity: true,
	ocrEnabled: false,
	outputFormat: 'markdown',
	quiet: true,
} satisfies LiteParseInit;

initSync({ module: wasmModule });

export type PdfAcquisitionDraft = Readonly<{
	kind: 'local-pdf';
	material: GenericAcquiredMaterial;
	parse: LocalPdfSummary;
}>;

export function isPdfAcquisitionDraft(value: GenericAcquiredMaterial | PdfAcquisitionDraft): value is PdfAcquisitionDraft {
	return 'kind' in value && value.kind === 'local-pdf';
}

type ParsedPdfAccumulator = {
	fallbackReasons: Set<string>;
	fullPageImagePages: number;
	incomplete: boolean;
	lastPage: number;
	layoutComplexPages: number;
	markdown: string[];
	pageErrorCount: number;
	paperIdentifierText: string | null;
	parsedPages: number;
};

type LocalPdfParseResult = Readonly<{
	markdown: string;
	paperIdentifierText: string | null;
	parse: LocalPdfSummary;
}>;

function accumulateLiteParseBatch(accumulator: ParsedPdfAccumulator, batch: ParseBatch): void {
	const result = batch.result;
	const expectedPageCount = batch.endPage - batch.startPage + 1;
	if (
		batch.startPage !== accumulator.lastPage + 1 ||
		expectedPageCount < 1 ||
		result.pages.length + result.pageErrors.length !== expectedPageCount
	) {
		accumulator.incomplete = true;
	}
	accumulator.lastPage = batch.endPage;
	const markdown = storageSafePdfMarkdown(result.text);
	if (markdown) accumulator.markdown.push(markdown);
	for (const page of result.pages) {
		accumulator.parsedPages++;
		const complexity = page.complexity;
		if (complexity?.needsOcr) {
			if (complexity.reasons.length) {
				for (const reason of complexity.reasons) accumulator.fallbackReasons.add(reason);
			} else {
				accumulator.fallbackReasons.add('needs-ocr');
			}
		}
		if (complexity?.isGarbled) accumulator.fallbackReasons.add('garbled');
		if (complexity?.fullPageImage) accumulator.fullPageImagePages++;
		if (complexity?.layout?.isComplex) accumulator.layoutComplexPages++;
		if (page.pageNum === 1 && accumulator.paperIdentifierText === null && !complexity?.isGarbled) {
			accumulator.paperIdentifierText = storageSafePdfMarkdown(page.markdown) || null;
		}
	}
	if (result.pageErrors.length) {
		accumulator.pageErrorCount += result.pageErrors.length;
		accumulator.fallbackReasons.add('page-error');
	}
}

function finishLocalPdfParse(accumulator: ParsedPdfAccumulator, totalPages: number): LocalPdfParseResult {
	if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error('LiteParse returned an invalid total page count');
	if (accumulator.incomplete || accumulator.lastPage !== totalPages) accumulator.fallbackReasons.add('incomplete');
	const markdown = storageSafePdfMarkdown(accumulator.markdown.join('\n\n'));
	if (!markdown) accumulator.fallbackReasons.add('empty-output');
	return {
		markdown,
		paperIdentifierText: accumulator.paperIdentifierText?.slice(0, MAX_PAPER_IDENTIFIER_TEXT_CHARS) ?? null,
		parse: {
			fallbackReasons: [...accumulator.fallbackReasons].sort(),
			fullPageImagePages: accumulator.fullPageImagePages,
			parserVersion: liteParsePackage.version,
			parsedPages: accumulator.parsedPages,
			totalPages,
		},
	};
}

async function parsePdfBytes(bytes: Uint8Array, sourceLabel: string): Promise<LocalPdfParseResult> {
	using parser = new LiteParse(LITEPARSE_CONFIG);
	let totalPages: number | null = null;
	try {
		using session = await parser.openBatchSession(bytes);
		totalPages = session.totalPages;
		const accumulator: ParsedPdfAccumulator = {
			fallbackReasons: new Set(),
			fullPageImagePages: 0,
			incomplete: false,
			lastPage: 0,
			layoutComplexPages: 0,
			markdown: [],
			pageErrorCount: 0,
			paperIdentifierText: null,
			parsedPages: 0,
		};
		for (;;) {
			const batch = await session.nextBatch();
			if (!batch) break;
			accumulateLiteParseBatch(accumulator, batch);
		}
		const result = finishLocalPdfParse(accumulator, totalPages);
		console.info({
			tag: 'PDF_PARSE',
			event: 'liteparse_completed',
			fallback_reasons: result.parse.fallbackReasons,
			full_page_image_pages: result.parse.fullPageImagePages,
			layout_complex_pages: accumulator.layoutComplexPages,
			outcome: localPdfNeedsFallback(result.parse) ? 'fallback-needed' : 'usable',
			page_error_count: accumulator.pageErrorCount,
			parser_version: result.parse.parserVersion,
			parsed_pages: result.parse.parsedPages,
			source: sourceLabel,
			total_pages: result.parse.totalPages,
		});
		return result;
	} catch (error) {
		console.error({
			tag: 'PDF_PARSE',
			event: 'liteparse_failed',
			parser_version: liteParsePackage.version,
			source: sourceLabel,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			markdown: '',
			paperIdentifierText: null,
			parse: {
				fallbackReasons: ['parse-failed'],
				fullPageImagePages: 0,
				parserVersion: liteParsePackage.version,
				parsedPages: 0,
				totalPages,
			},
		};
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
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: input.grant,
		local: input.acquisition.parse,
		processingId: input.processingId,
		source: { kind: 'public-url', url: input.sourceUrl },
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
			'acquire-openalex-content-pdf-v7',
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
			local_parse_outcome: localPdfNeedsFallback(local.parse) ? 'fallback-needed' : 'usable',
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
	target: Readonly<{
		paidPdfFallback: PaidPdfFallbackGrant | null;
		resourceId: string;
	}>,
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
	const [contentStream, grobidHeader] = await Promise.all([
		step.do(
			'acquire-stored-pdf-v6',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			async () => Response.json(await acquireStoredPdf(env, resource)).body!,
		),
		step
			.do<GrobidPdfHeader>('classify-stored-pdf-with-grobid-v1', GROBID_HEADER_STEP, async () => {
				const object = await env.R2.get(resource.storageKey);
				if (!object) throw new NonRetryableError('Uploaded PDF object is missing');
				if (object.size < 1 || object.size > MAX_PDF_BYTES) {
					await object.body.cancel('Uploaded PDF size is outside the supported range');
					throw new NonRetryableError(`Uploaded PDF must contain 1-${MAX_PDF_BYTES} bytes`);
				}
				return env.GROBID.getByName(GROBID_CONTAINER_NAME).processPdfHeader(object.body, object.size);
			})
			.catch((error) => {
				console.warn({
					tag: 'GROBID',
					event: 'paper_classification_failed',
					resource_id: target.resourceId,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}),
	]);
	const acquisition = await new Response(contentStream).json<PdfAcquisitionDraft>();
	const paperIdentifierText = grobidHeader ? grobidPaperIdentifierText(grobidHeader) : null;
	const paperHeader = paperIdentifierText ? grobidHeader : null;
	const material: GenericAcquiredMaterial = {
		...acquisition.material,
		paperIdentifierText,
		...(paperHeader?.title ? { title: paperHeader.title } : {}),
		...(paperHeader?.authors.length ? { creators: paperHeader.authors.flatMap((author) => literalCreator('author', author)) } : {}),
	};
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: target.paidPdfFallback,
		local: acquisition.parse,
		processingId: target.resourceId,
		source: {
			kind: 'private-upload',
			storageKey: resource.storageKey,
		},
	});
	if (!cloudMarkdown) {
		requireUsablePdf(acquisition, `Stored PDF ${target.resourceId}`);
		return material;
	}
	return {
		...material,
		markdown: cloudMarkdown,
	};
}
