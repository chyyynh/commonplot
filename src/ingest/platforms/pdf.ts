import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import {
	type AcquiredResource,
	canonicalizeResourceLang,
	type ResourceAcquisitionHints,
	ResourceCreatorsSchema,
	resolveResourceHints,
} from '../../shared/resource';
import { limitByteStream } from '../../shared/response';
import { resolveCrossrefPaperCandidate } from '../crossref';
import type { GrobidPdfHeader } from '../grobid-tei';
import { normalizeStructuredPdf, type StructuredPdfDocument, structuredPdfSourceCrops } from '../zotero-sdt.ts';
import {
	ensureStructuredPdfSourceCrops,
	parsePdfArtifactStream,
	readStructuredPdfArtifact,
	writeStructuredPdfArtifact,
} from '../zotero-sdt-service.ts';
import { fetchOpenAlexPdf } from './openalex';
import { MAX_PDF_BYTES, PDF_MIME } from './pdf-constants';
import type { LocalPdfSummary, PaidPdfFallbackGrant } from './pdf-fallback-policy.ts';
import { stagePaidLlamaParseFallback } from './pdf-llamaparse';

export { PDF_MIME } from './pdf-constants';
export type { PaidPdfFallbackGrant } from './pdf-fallback-policy.ts';

const MAX_PAPER_IDENTIFIER_TEXT_CHARS = 20_000;
const GROBID_HEADER_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '600 seconds' } as const;
const CROSSREF_PAPER_CANDIDATE_STEP = {
	retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
	timeout: '30 seconds',
} as const;

type PdfAcquisition = Readonly<{
	resource: AcquiredResource & { kind: 'file'; resourcePlatform: null; paperIdentifierText: string | null };
	parse: LocalPdfSummary;
}>;

type LocalPdfParseResult = { markdown: string; paperIdentifierText: string | null; parse: LocalPdfSummary };

function localPdfResult(normalized: ReturnType<typeof normalizeStructuredPdf>, sourceLabel: string): LocalPdfParseResult {
	const { markdown, paperIdentifierText, parse } = normalized;
	console.info({
		tag: 'PDF_PARSE',
		event: 'zotero_sdt_completed',
		fallback_reasons: parse.fallbackReasons,
		full_page_image_pages: parse.fullPageImagePages,
		mention_count: normalized.mentions.length,
		parser_version: parse.parserVersion,
		reference_count: normalized.references.length,
		source: sourceLabel,
		total_pages: parse.totalPages,
	});
	return { markdown, paperIdentifierText, parse };
}

/** Finish a direct public PDF after the retrying fetch/local-parse step has ended. */
export async function completeFetchedPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquisition: PdfAcquisition;
		grant: PaidPdfFallbackGrant | null;
		processingId: string;
		sourceUrl: string;
	},
): Promise<PdfAcquisition['resource']> {
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: input.grant,
		local: input.acquisition.parse,
		processingId: input.processingId,
		source: { kind: 'public-url', url: input.sourceUrl },
	});
	if (!cloudMarkdown) {
		if (!input.acquisition.resource.content) throw new NonRetryableError('Fetched PDF has no usable text; OCR is required');
		return input.acquisition.resource;
	}
	return {
		...input.acquisition.resource,
		content: cloudMarkdown,
		paperIdentifierText: cloudMarkdown.slice(0, MAX_PAPER_IDENTIFIER_TEXT_CHARS),
	};
}

/** OpenAlex content URLs need our API key, so this optional representation is always local-only. */
export async function stageOpenAlexPdfMarkdown(env: CoreEnv, step: WorkflowStep, input: { contentPdfUrl: string; processingId: string }) {
	try {
		const contentStream = await step.do(
			'acquire-openalex-content-pdf-v10',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
			async () => {
				const response = await fetchOpenAlexPdf({ apiKey: env.OPENALEX_API_KEY, contentPdfUrl: input.contentPdfUrl });
				return new Response((await parseFetchedPdfResponse(env, response)).markdown).body!;
			},
		);
		const markdown = await new Response(contentStream).text();
		if (!markdown) throw new NonRetryableError('OpenAlex content PDF has no usable text; OCR is required');
		console.info({
			tag: 'OPENALEX_CONTENT',
			event: 'pdf_acquired',
			processing_id: input.processingId,
			chars: markdown.length,
		});
		return markdown;
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

type StoredPdfRow = {
	content_hash: string | null;
	creators: unknown;
	original_lang: string;
	published_date: Date | string | null;
	source: string;
	storage_key: string;
	summary: string | null;
	title: string | null;
};

async function loadStoredPdfInput(db: NodePgDatabase, resourceId: string) {
	const result = await db.execute<StoredPdfRow>(sql`
		SELECT
			resource.content_hash,
			original.title,
			original.summary,
			resource.original_lang,
			COALESCE(resource.source_name, 'File') AS source,
			resource.published_date,
			resource.creators,
			resource.storage_key
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'private'
		  AND resource.kind = 'file'
		  AND resource.file_type = ${PDF_MIME}
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (SELECT 1 FROM user_files file WHERE file.resource_id = resource.id)
	`);
	const row = result.rows[0];
	if (!row) throw new NonRetryableError(`Failed to fetch stored PDF ${resourceId}: not found or not an owned private blob`);
	const title = row.title?.trim();
	if (!title) throw new NonRetryableError(`Stored PDF ${resourceId} has no title`);
	if (!row.content_hash || !/^[a-f\d]{64}$/u.test(row.content_hash)) {
		throw new NonRetryableError(`Stored PDF ${resourceId} has no valid content hash`);
	}
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new NonRetryableError('Invalid published_date: expected date');
	const creators = ResourceCreatorsSchema.safeParse(row.creators);
	if (!creators.success) throw new NonRetryableError(`Invalid creators for ${resourceId}: ${creators.error.message}`);
	return {
		contentHash: row.content_hash,
		creators: creators.data,
		originalLang: canonicalizeResourceLang(row.original_lang),
		publishedDate: publishedDate?.toISOString() ?? null,
		source: row.source,
		storageKey: row.storage_key,
		summary: row.summary,
		title,
	};
}

type StoredPdfInput = Awaited<ReturnType<typeof loadStoredPdfInput>>;

async function acquireStoredPdf(env: CoreEnv, resource: StoredPdfInput, resourceId: string): Promise<PdfAcquisition> {
	const sourceLabel = `Stored PDF ${resourceId}`;
	let attempt: StructuredPdfDocument | LocalPdfParseResult | null = null;
	try {
		attempt = await readStructuredPdfArtifact(env, resource.storageKey, resource.contentHash);
	} catch (error) {
		console.warn({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_artifact_invalid',
			resource_id: resourceId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (attempt) {
		console.info({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_artifact_reused',
			parser_version: `zotero-pdf-${attempt.metadata.processor.version}/sdt-${attempt.schemaVersion}`,
			resource_id: resourceId,
		});
	} else {
		const object = await env.R2.get(resource.storageKey);
		if (!object) throw new NonRetryableError(`PDF source object missing: ${resource.storageKey}`);
		if (object.size < 1 || object.size > MAX_PDF_BYTES) {
			await object.body.cancel('Stored PDF size is outside the supported range');
			throw new NonRetryableError(`PDF source object must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		attempt = await parsePdfArtifactStream(env, object.body, object.size, sourceLabel);
		if ('schemaVersion' in attempt) await writeStructuredPdfArtifact(env, resource.storageKey, resource.contentHash, attempt);
	}
	let parsed: LocalPdfParseResult;
	if ('schemaVersion' in attempt) {
		const readySourceCrops = await ensureStructuredPdfSourceCrops(env, {
			crops: structuredPdfSourceCrops(attempt),
			inputContentHash: resource.contentHash,
			pdfStorageKey: resource.storageKey,
			resourceId,
		});
		parsed = localPdfResult(
			normalizeStructuredPdf(attempt, {
				inputContentHash: resource.contentHash,
				readySourceCrops,
			}),
			sourceLabel,
		);
	} else parsed = attempt;
	return {
		resource: {
			kind: 'file',
			resourceIdentifiers: [],
			subject: null,
			previewImageUrl: null,
			resourcePlatform: null,
			fileType: PDF_MIME,
			url: null,
			title: resource.title,
			content: parsed.markdown,
			paperIdentifierText: parsed.paperIdentifierText,
			source: resource.source,
			...resolveResourceHints(resource, resource),
			creators: resource.creators,
			kindMetadata: null,
		},
		parse: parsed.parse,
	};
}

async function parseFetchedPdfResponse(env: CoreEnv, response: Response) {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
		await response.body?.cancel('Fetched PDF size is outside the supported range');
		throw new NonRetryableError(`PDF exceeded ${MAX_PDF_BYTES} bytes`);
	}
	if (!response.body) throw new NonRetryableError('Fetched PDF response body is empty');
	const body = limitByteStream(response.body, MAX_PDF_BYTES, () => new NonRetryableError(`PDF exceeded ${MAX_PDF_BYTES} bytes`));
	const attempt = await parsePdfArtifactStream(env, body, null, 'Fetched PDF');
	return 'schemaVersion' in attempt ? localPdfResult(normalizeStructuredPdf(attempt), 'Fetched PDF') : attempt;
}

export async function acquireFetchedPdfResponse(
	env: CoreEnv,
	response: Response,
	finalUrl: string,
	hints: ResourceAcquisitionHints,
): Promise<PdfAcquisition> {
	const parsed = await parseFetchedPdfResponse(env, response);
	const url = new URL(finalUrl);
	let fileName = url.pathname.split('/').filter(Boolean).at(-1) || 'document.pdf';
	try {
		fileName = decodeURIComponent(fileName) || 'document.pdf';
	} catch {
		// Keep a malformed path segment in its encoded form.
	}
	const title = fileName.replace(/\.[a-z0-9]+$/i, '').trim();
	if (!title) throw new NonRetryableError(`File name has no title: ${fileName}`);
	const source = url.hostname.replace(/^www\./, '');
	return {
		resource: {
			kind: 'file',
			resourceIdentifiers: [],
			subject: null,
			previewImageUrl: null,
			resourcePlatform: null,
			fileType: PDF_MIME,
			url: finalUrl,
			title,
			content: parsed.markdown,
			paperIdentifierText: parsed.paperIdentifierText,
			source,
			...resolveResourceHints(hints, hints),
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
		paidPdfFallback?: PaidPdfFallbackGrant;
		resourceId: string;
	}>,
): Promise<PdfAcquisition['resource']> {
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
			'acquire-stored-pdf-v8',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
			async () => Response.json(await acquireStoredPdf(env, resource, target.resourceId)).body!,
		),
		step
			.do<GrobidPdfHeader>('classify-stored-pdf-with-grobid-v1', GROBID_HEADER_STEP, async () => {
				const object = await env.R2.get(resource.storageKey);
				if (!object) throw new NonRetryableError('Uploaded PDF object is missing');
				return env.GROBID.getByName('citation-parser-v1').processPdfHeader(object.body, object.size);
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
	const acquisition = await new Response(contentStream).json<PdfAcquisition>();
	let paperIdentifierText = grobidHeader?.paperIdentifierText ?? null;
	const grobidTitle = grobidHeader?.title;
	if (!paperIdentifierText && grobidTitle && grobidHeader.authors.length) {
		try {
			const crossref = await step.do('confirm-stored-pdf-with-crossref-v1', CROSSREF_PAPER_CANDIDATE_STEP, () =>
				resolveCrossrefPaperCandidate(grobidTitle, grobidHeader.authors),
			);
			paperIdentifierText = crossref ? `DOI: ${crossref.doi}` : null;
			console.info({
				tag: 'PAPER_PROVIDER',
				event: 'stored_pdf_candidate_confirmation',
				provider: 'crossref',
				resource_id: target.resourceId,
				outcome: crossref ? 'resolved' : 'not_found',
				...(crossref ? { doi: crossref.doi, venue: crossref.venue, year: crossref.year } : {}),
			});
		} catch (error) {
			console.warn({
				tag: 'PAPER_PROVIDER',
				event: 'stored_pdf_candidate_confirmation',
				provider: 'crossref',
				resource_id: target.resourceId,
				outcome: 'failed',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const paperHeader = paperIdentifierText ? grobidHeader : null;
	const acquired = {
		...acquisition.resource,
		paperIdentifierText,
		...(paperHeader?.title ? { title: paperHeader.title.trim() } : {}),
		...(paperHeader?.authors.length ? { creators: paperHeader.authors.map((literal) => ({ literal, role: 'author' as const })) } : {}),
	};
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: target.paidPdfFallback ?? null,
		local: acquisition.parse,
		processingId: target.resourceId,
		source: {
			kind: 'private-upload',
			storageKey: resource.storageKey,
		},
	});
	if (!cloudMarkdown && !acquired.content)
		throw new NonRetryableError(`Stored PDF ${target.resourceId} has no usable text; OCR is required`);
	return cloudMarkdown ? { ...acquired, content: cloudMarkdown } : acquired;
}
