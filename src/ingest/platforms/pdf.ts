import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { paperIdentifiersFromIdentity, paperIdentityFromText } from '../../shared/paper-identity';
import { ResourceCreatorsSchema } from '../../shared/resource';
import type { AcquiredResource } from '../acquisition';
import { type GrobidPdfHeader, parseGrobidPdfHeader } from '../grobid-tei';
import { parseStoredPdfRepresentation, type storePublicPdfResponse } from '../zotero-sdt-service.ts';
import { stagePaidLlamaParseFallback } from './pdf-llamaparse';
import { PDF_MIME, type PaidPdfFallbackGrant } from './pdf-policy';

const GROBID_HEADER_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '600 seconds' } as const;
type PdfAcquisition = Readonly<{
	resource: AcquiredResource & { kind: 'file'; resourcePlatform: null; url: string };
}>;

type StoredPdfRow = {
	content_hash: string;
	creators: unknown;
	original_lang: string;
	published_date: string | null;
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
	const publishedDate = row.published_date === null ? null : new Date(row.published_date);
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new NonRetryableError('Invalid published_date: expected date');
	const creators = ResourceCreatorsSchema.safeParse(row.creators);
	if (!creators.success) throw new NonRetryableError(`Invalid creators for ${resourceId}: ${creators.error.message}`);
	return {
		contentHash: row.content_hash,
		creators: creators.data,
		originalLang: row.original_lang,
		publishedDate: publishedDate?.toISOString() ?? null,
		source: row.source,
		storageKey: row.storage_key,
		summary: row.summary,
		title,
	};
}

const PDF_PARSE_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' } as const;

type PdfBody = Pick<Awaited<ReturnType<typeof parseStoredPdfRepresentation>>, 'markdown' | 'references' | 'parse' | 'paperIdentifierText'>;

/** Zotero reads the body of every PDF. */
async function stagePdfBody(
	env: CoreEnv,
	step: WorkflowStep,
	input: Readonly<{ stepKey: string; pdfStorageKey: string; inputContentHash: string; sourceLabel: string; cropUrlPrefix?: string }>,
): Promise<PdfBody> {
	const stream = await step.do(`parse-pdf-body-v1-${input.stepKey}`, PDF_PARSE_STEP, async () => {
		const { markdown, references, parse, paperIdentifierText } = await parseStoredPdfRepresentation(env, input);
		return Response.json({ markdown, references, parse, paperIdentifierText }).body!;
	});
	return new Response(stream).json<PdfBody>();
}

/** GROBID reads an uploaded PDF's title page; without it no identifier in the PDF can be verified. */
async function stagePdfHeader(env: CoreEnv, step: WorkflowStep, input: Readonly<{ pdfStorageKey: string; sourceLabel: string }>) {
	try {
		const stream = await step.do('parse-pdf-header-grobid-v1-stored', GROBID_HEADER_STEP, async () => {
			const object = await env.R2.get(input.pdfStorageKey);
			if (!object) throw new NonRetryableError('PDF source object is missing');
			const parsed = await parseGrobidPdfHeader(
				await env.GROBID.getByName('citation-parser-v1').processPdfHeader(object.body, object.size),
			);
			return Response.json(parsed).body!;
		});
		return await new Response(stream).json<GrobidPdfHeader>();
	} catch (error) {
		console.warn({
			tag: 'GROBID',
			event: 'pdf_header_failed',
			source: input.sourceLabel,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export async function stagePublicPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: { source: Awaited<ReturnType<typeof storePublicPdfResponse>>; grant: PaidPdfFallbackGrant | null; processingId: string },
): Promise<PdfAcquisition['resource']> {
	const url = new URL(input.source.url);
	let fileName = url.pathname.split('/').filter(Boolean).at(-1) || 'document.pdf';
	try {
		fileName = decodeURIComponent(fileName) || 'document.pdf';
	} catch {
		// Keep a malformed path segment in its encoded form.
	}
	const title = fileName.replace(/\.[a-z0-9]+$/i, '').trim();
	if (!title) throw new NonRetryableError(`File name has no title: ${fileName}`);
	const parsed = await stagePdfBody(env, step, { ...input.source, stepKey: input.source.pdfStorageKey });
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: input.grant,
		local: parsed.parse,
		processingId: input.processingId,
		source: { kind: 'public-url', url: input.source.url },
	});
	if (!cloudMarkdown && !parsed.markdown) throw new NonRetryableError('Fetched PDF has no usable text; OCR is required');
	return {
		kind: 'file',
		resourceIdentifiers: [],
		subjectUrl: null,
		previewImageUrl: null,
		resourcePlatform: null,
		fileType: PDF_MIME,
		url: input.source.url,
		title,
		content: cloudMarkdown || parsed.markdown,
		references: cloudMarkdown ? [] : parsed.references,
		source: url.hostname.replace(/^www\./, ''),
		originalLang: 'und',
		publishedDate: null,
		summary: null,
		creators: [],
		kindMetadata: null,
	};
}

export async function stageStoredPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	target: Readonly<{
		paidPdfFallback?: PaidPdfFallbackGrant;
		resourceId: string;
	}>,
	processingId: string,
): Promise<AcquiredResource & { kind: 'file'; resourcePlatform: null; printedTitle: string | null }> {
	const resource = await step.do(
		'load-stored-pdf-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadStoredPdfInput(await connectCoreDb(env), target.resourceId),
	);
	const sourceLabel = `Stored PDF ${target.resourceId}`;
	const [parsed, printed] = await Promise.all([
		stagePdfBody(env, step, { stepKey: 'stored', pdfStorageKey: resource.storageKey, inputContentHash: resource.contentHash, sourceLabel }),
		stagePdfHeader(env, step, { pdfStorageKey: resource.storageKey, sourceLabel }),
	]);
	// Identifiers printed on the title page: GROBID's header, else DOI/arXiv text found on the first page.
	const printedIdentity = paperIdentityFromText(parsed.paperIdentifierText);
	const resourceIdentifiers = printed?.resourceIdentifiers.length
		? printed.resourceIdentifiers
		: printedIdentity
			? paperIdentifiersFromIdentity(printedIdentity)
			: [];
	const printedTitle = printed?.title?.trim() || null;
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: target.paidPdfFallback ?? null,
		local: parsed.parse,
		processingId,
		source: {
			kind: 'private-upload',
			storageKey: resource.storageKey,
		},
	});
	if (!cloudMarkdown && !parsed.markdown)
		throw new NonRetryableError(`Stored PDF ${target.resourceId} has no usable text; OCR is required`);
	// GROBID reads a heading from any PDF; only a title page that names a paper replaces the file name.
	const header = resourceIdentifiers.length ? printed : null;
	return {
		kind: 'file',
		resourceIdentifiers,
		printedTitle,
		subjectUrl: null,
		previewImageUrl: null,
		resourcePlatform: null,
		fileType: PDF_MIME,
		url: null,
		title: (header && printedTitle) || resource.title,
		content: cloudMarkdown || parsed.markdown,
		references: cloudMarkdown ? [] : parsed.references,
		source: resource.source,
		originalLang: resource.originalLang,
		publishedDate: resource.publishedDate,
		summary: resource.summary,
		creators: header?.authors.length ? header.authors.map((literal) => ({ literal, role: 'author' as const })) : resource.creators,
		kindMetadata: null,
	};
}
