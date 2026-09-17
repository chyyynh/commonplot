import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { paperIdentifiersFromIdentity, paperIdentityFromText } from '../../shared/paper-identity';
import { ResourceCreatorsSchema } from '../../shared/resource';
import type { AcquiredResource } from '../acquisition';
import type { GrobidPdfHeader } from '../grobid-tei';
import { ResourceLanguageSchema } from '../resource-language';
import { parsePublicPdfResponse, parseStoredPdfRepresentation } from '../zotero-sdt-service.ts';
import { stagePaperResolution } from './paper';
import { stagePaidLlamaParseFallback } from './pdf-llamaparse';
import { PDF_MIME, type LocalPdfSummary, type PaidPdfFallbackGrant } from './pdf-policy';
import { resolveResourceUrl } from './resource-url';

const MAX_PAPER_IDENTIFIER_TEXT_CHARS = 20_000;
const GROBID_HEADER_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '600 seconds' } as const;
type PdfAcquisition = Readonly<{
	resource: AcquiredResource & { kind: 'file'; resourcePlatform: null; url: string };
	parse: LocalPdfSummary;
}>;

/** Finish a direct public PDF after the retrying fetch/local-parse step has ended. */
export async function completeFetchedPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquisition: PdfAcquisition;
		grant: PaidPdfFallbackGrant | null;
		processingId: string;
	},
): Promise<PdfAcquisition['resource']> {
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: input.grant,
		local: input.acquisition.parse,
		processingId: input.processingId,
		source: { kind: 'public-url', url: input.acquisition.resource.url },
	});
	if (!cloudMarkdown) {
		if (!input.acquisition.resource.content) throw new NonRetryableError('Fetched PDF has no usable text; OCR is required');
		return input.acquisition.resource;
	}
	const identity = paperIdentityFromText(cloudMarkdown.slice(0, MAX_PAPER_IDENTIFIER_TEXT_CHARS));
	return {
		...input.acquisition.resource,
		citations: null,
		content: cloudMarkdown,
		resourceIdentifiers: [
			...(resolveResourceUrl(input.acquisition.resource.url)?.identifiers ?? []),
			...(identity ? paperIdentifiersFromIdentity(identity) : []),
		],
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

export async function acquireFetchedPdfResponse(env: CoreEnv, response: Response, finalUrl: string): Promise<PdfAcquisition> {
	const parsed = await parsePublicPdfResponse(env, response, finalUrl);
	const identity = paperIdentityFromText(parsed.paperIdentifierText);
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
			resourceIdentifiers: identity ? paperIdentifiersFromIdentity(identity) : [],
			subjectUrl: null,
			previewImageUrl: null,
			resourcePlatform: null,
			fileType: PDF_MIME,
			url: finalUrl,
			title,
			content: parsed.markdown,
			citations: parsed.citations,
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
): Promise<AcquiredResource & { resourcePlatform: null }> {
	const resource = await step.do(
		'load-stored-pdf-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadStoredPdfInput(await connectCoreDb(env), target.resourceId),
	);
	const [contentStream, grobidHeader] = await Promise.all([
		step.do(
			'acquire-stored-pdf-v12',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
			async () => {
				const { markdown, citations, parse } = await parseStoredPdfRepresentation(env, {
					pdfStorageKey: resource.storageKey,
					inputContentHash: resource.contentHash,
					sourceLabel: `Stored PDF ${target.resourceId}`,
				});
				return Response.json({ markdown, citations, parse }).body!;
			},
		),
		step
			.do<GrobidPdfHeader>('classify-stored-pdf-with-grobid-v2', GROBID_HEADER_STEP, async () => {
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
	const parsed = await new Response(contentStream).json<
		Pick<Awaited<ReturnType<typeof parseStoredPdfRepresentation>>, 'markdown' | 'citations' | 'parse'>
	>();
	const paperIdentifiers = grobidHeader?.resourceIdentifiers ?? [];
	const paperHeader = paperIdentifiers.length ? grobidHeader : null;
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: target.paidPdfFallback ?? null,
		local: parsed.parse,
		processingId: target.resourceId,
		source: {
			kind: 'private-upload',
			storageKey: resource.storageKey,
		},
	});
	if (!cloudMarkdown && !parsed.markdown)
		throw new NonRetryableError(`Stored PDF ${target.resourceId} has no usable text; OCR is required`);
	return stagePaperResolution(env, step, {
		resource: {
			kind: 'file',
			resourceIdentifiers: paperIdentifiers,
			subjectUrl: null,
			previewImageUrl: null,
			resourcePlatform: null,
			fileType: PDF_MIME,
			url: null,
			title: paperHeader?.title ? paperHeader.title.trim() : resource.title,
			content: cloudMarkdown || parsed.markdown,
			citations: cloudMarkdown ? null : parsed.citations,
			source: resource.source,
			originalLang: resource.originalLang,
			publishedDate: resource.publishedDate,
			summary: resource.summary,
			creators: paperHeader?.authors.length
				? paperHeader.authors.map((literal) => ({ literal, role: 'author' as const }))
				: resource.creators,
			kindMetadata: null,
		},
		processingId: target.resourceId,
		...(!paperIdentifiers.length && grobidHeader?.title && grobidHeader.authors.length
			? { candidate: { title: grobidHeader.title, authors: grobidHeader.authors } }
			: {}),
	});
}
