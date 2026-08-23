import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { PersistResolvedResourceTarget } from '@app-domain/resource-graph-contracts';
import { canonicalPaperUrl, paperIdentityFromIdentifiers } from '@core-shared/paper-identity';
import { isPaperIdentifier, type ResourceCreator, type ResourceKindMetadata } from '@core-shared/resource';
import { parsePdfWithLiteParse } from './liteparse';
import type { GenericAcquiredMaterial, ResolvedResource } from './materialize';

export const PDF_MIME = 'application/pdf';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export type StoredPdfAcquisitionInput = {
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

export type StoredPdfProcessingResult = {
	resource: ResolvedResource;
	persistenceTarget: PersistResolvedResourceTarget;
};

async function parsePdfBytes(bytes: Uint8Array, source: string): Promise<string> {
	const result = await parsePdfWithLiteParse(bytes);
	const markdown = result.markdown;
	if (!markdown) throw new NonRetryableError(`${source} has no usable text; OCR is required`);
	return markdown;
}

async function acquireStoredPdf(env: CoreEnv, resource: StoredPdfAcquisitionInput): Promise<GenericAcquiredMaterial> {
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
	const markdown = await parsePdfBytes(await new Response(body).bytes(), `PDF ${finalUrl}`);
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
	resource: StoredPdfAcquisitionInput,
): Promise<GenericAcquiredMaterial> {
	const contentStream = await step.do(
		'acquire-stored-pdf-v2',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await acquireStoredPdf(env, resource)).body!,
	);
	return new Response(contentStream).json<GenericAcquiredMaterial>();
}

export function storedPdfProcessingResult(resource: ResolvedResource, input: { resourceId: string }): StoredPdfProcessingResult {
	if (resource.kind !== 'paper') {
		return {
			resource,
			persistenceTarget: { kind: 'existing', resourceId: input.resourceId },
		};
	}
	const identity = paperIdentityFromIdentifiers(resource.resourceIdentifiers.filter(isPaperIdentifier));
	if (!identity) throw new Error(`Private paper processing ${input.resourceId} has no canonical identity`);
	const url = canonicalPaperUrl(identity);
	return {
		resource: { ...resource, url, normalizedUrl: url },
		persistenceTarget: {
			kind: 'draft',
			admission: { kind: 'userFilePaper', fileResourceId: input.resourceId },
			providerSequence: null,
		},
	};
}
