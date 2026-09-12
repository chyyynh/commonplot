import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { ResourceCreatorsSchema } from '../../shared/resource';
import type { AcquiredResource } from '../acquisition';
import { resolveCrossrefPaperCandidate } from '../crossref';
import type { GrobidPdfHeader } from '../grobid-tei';
import { ResourceLanguageSchema } from '../resource-language';
import { parsePublicPdfResponse, parseStoredPdfRepresentation, PermanentPdfArtifactError } from '../zotero-sdt-service.ts';
import { stagePaidLlamaParseFallback } from './pdf-llamaparse';
import { PDF_MIME, type LocalPdfSummary, type PaidPdfFallbackGrant } from './pdf-policy';

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

async function localPdfAttempt<T>(attempt: Promise<T>): Promise<T> {
	try {
		return await attempt;
	} catch (error) {
		if (error instanceof PermanentPdfArtifactError) throw new NonRetryableError(error.message);
		throw error;
	}
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
		citations: null,
		content: cloudMarkdown,
		paperIdentifierText: cloudMarkdown.slice(0, MAX_PAPER_IDENTIFIER_TEXT_CHARS),
	};
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
		originalLang: ResourceLanguageSchema.parse(row.original_lang),
		publishedDate: publishedDate?.toISOString() ?? null,
		source: row.source,
		storageKey: row.storage_key,
		summary: row.summary,
		title,
	};
}

type StoredPdfInput = Awaited<ReturnType<typeof loadStoredPdfInput>>;

async function acquireStoredPdf(env: CoreEnv, resource: StoredPdfInput, resourceId: string): Promise<PdfAcquisition> {
	const parsed = await localPdfAttempt(
		parseStoredPdfRepresentation(env, {
			pdfStorageKey: resource.storageKey,
			inputContentHash: resource.contentHash,
			sourceLabel: `Stored PDF ${resourceId}`,
		}),
	);
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
			citations: parsed.citations,
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

export async function acquireFetchedPdfResponse(env: CoreEnv, response: Response, finalUrl: string): Promise<PdfAcquisition> {
	const parsed = await localPdfAttempt(parsePublicPdfResponse(env, response, finalUrl));
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
			citations: parsed.citations,
			paperIdentifierText: parsed.paperIdentifierText,
			source,
			originalLang: 'und',
			publishedDate: null,
			summary: null,
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
	);
	const [contentStream, grobidHeader] = await Promise.all([
		step.do(
			'acquire-stored-pdf-v10',
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
	return cloudMarkdown ? { ...acquired, citations: null, content: cloudMarkdown } : acquired;
}
