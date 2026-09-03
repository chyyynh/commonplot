import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { canonicalizeResourceLang, type ResourceCreator, ResourceCreatorsSchema } from '../../shared/resource';
import { GROBID_CONTAINER_NAME } from '../grobid-container';
import { type GrobidPdfHeader, grobidPaperIdentifierText } from '../grobid-tei';
import { ZOTERO_SDT_ARTIFACT_VERSION } from '../zotero-sdt.ts';
import {
	parsePdfWithZotero,
	readStructuredPdfArtifact,
	type StructuredPdfArtifact,
	writeStructuredPdfArtifact,
} from '../zotero-sdt-service.ts';
import { type GenericAcquiredMaterial, literalCreator } from './materialize';
import { fetchOpenAlexPdf } from './openalex';
import { MAX_PDF_BYTES, PDF_MIME } from './pdf-constants';
import { type LocalPdfSummary, localPdfNeedsFallback, type PaidPdfFallbackGrant } from './pdf-fallback-policy.ts';
import { stagePaidLlamaParseFallback } from './pdf-llamaparse';

export { PDF_MIME } from './pdf-constants';
export type { PaidPdfFallbackGrant } from './pdf-fallback-policy.ts';

const MAX_PAPER_IDENTIFIER_TEXT_CHARS = 20_000;
const GROBID_HEADER_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '600 seconds' } as const;

export type PdfAcquisitionDraft = Readonly<{
	kind: 'local-pdf';
	material: GenericAcquiredMaterial;
	parse: LocalPdfSummary;
}>;

export function isPdfAcquisitionDraft(value: GenericAcquiredMaterial | PdfAcquisitionDraft): value is PdfAcquisitionDraft {
	return 'kind' in value && value.kind === 'local-pdf';
}

type LocalPdfParseResult = Readonly<{
	markdown: string;
	paperIdentifierText: string | null;
	parse: LocalPdfSummary;
}>;

type PdfParseAttempt = Readonly<{
	artifact: StructuredPdfArtifact | null;
	result: LocalPdfParseResult;
}>;

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function parsePdfStream(
	env: CoreEnv,
	input: ReadableStream<Uint8Array>,
	byteLength: number,
	sourceLabel: string,
): Promise<PdfParseAttempt> {
	try {
		const artifact = await parsePdfWithZotero(env, input, byteLength);
		const result: LocalPdfParseResult = {
			markdown: artifact.normalized.markdown,
			paperIdentifierText: artifact.normalized.paperIdentifierText?.slice(0, MAX_PAPER_IDENTIFIER_TEXT_CHARS) ?? null,
			parse: artifact.normalized.parse,
		};
		console.info({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_completed',
			fallback_reasons: result.parse.fallbackReasons,
			full_page_image_pages: result.parse.fullPageImagePages,
			mention_count: artifact.normalized.mentions.length,
			outcome: localPdfNeedsFallback(result.parse) ? 'fallback-needed' : 'usable',
			parser_version: result.parse.parserVersion,
			parsed_pages: result.parse.parsedPages,
			reference_count: artifact.normalized.references.length,
			source: sourceLabel,
			total_pages: result.parse.totalPages,
		});
		return { artifact, result };
	} catch (error) {
		console.error({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_failed',
			parser_version: ZOTERO_SDT_ARTIFACT_VERSION,
			source: sourceLabel,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			artifact: null,
			result: {
				markdown: '',
				paperIdentifierText: null,
				parse: {
					fallbackReasons: ['parse-failed'],
					fullPageImagePages: 0,
					parserVersion: ZOTERO_SDT_ARTIFACT_VERSION,
					parsedPages: 0,
					totalPages: null,
				},
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
			'acquire-openalex-content-pdf-v8',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
			async () => {
				const response = await fetchOpenAlexPdf({ apiKey: env.OPENALEX_API_KEY, contentPdfUrl: input.contentPdfUrl });
				return Response.json(await acquireFetchedPdfResponse(env, response, input.contentPdfUrl)).body!;
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
	contentHash: string;
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
	content_hash: string | null;
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
			resource.content_hash,
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
	if (!row.content_hash || !/^[a-f\d]{64}$/u.test(row.content_hash)) {
		throw new NonRetryableError(`Stored PDF ${resourceId} has no valid content hash`);
	}
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new NonRetryableError('Invalid published_date: expected date');
	let creators: ResourceCreator[];
	try {
		creators = ResourceCreatorsSchema.parse(row.creators);
	} catch (error) {
		throw new NonRetryableError(`Invalid creators for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		contentHash: row.content_hash,
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
	const sourceLabel = `Stored PDF ${resource.resourceId}`;
	let artifact: StructuredPdfArtifact | null = null;
	try {
		artifact = await readStructuredPdfArtifact(env, resource.storageKey, resource.contentHash);
	} catch (error) {
		console.warn({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_artifact_invalid',
			resource_id: resource.resourceId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	let parsed: LocalPdfParseResult;
	if (artifact) {
		parsed = {
			markdown: artifact.normalized.markdown,
			paperIdentifierText: artifact.normalized.paperIdentifierText,
			parse: artifact.normalized.parse,
		};
		console.info({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_artifact_reused',
			parser_version: parsed.parse.parserVersion,
			resource_id: resource.resourceId,
		});
	} else {
		const object = await env.R2.get(resource.storageKey);
		if (!object) throw new NonRetryableError(`PDF source object missing: ${resource.storageKey}`);
		if (object.size < 1 || object.size > MAX_PDF_BYTES) {
			await object.body.cancel('Stored PDF size is outside the supported range');
			throw new NonRetryableError(`PDF source object must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		const attempt = await parsePdfStream(env, object.body, object.size, sourceLabel);
		parsed = attempt.result;
		if (attempt.artifact) {
			await writeStructuredPdfArtifact(env, resource.storageKey, resource.contentHash, attempt.artifact);
		}
	}
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

export async function acquireFetchedPdfResponse(env: CoreEnv, response: Response, finalUrl: string): Promise<PdfAcquisitionDraft> {
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
	const bytes = await new Response(body).bytes();
	const parsed = (await parsePdfStream(env, byteStream(bytes), bytes.byteLength, 'Fetched PDF')).result;
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
			'acquire-stored-pdf-v7',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
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
