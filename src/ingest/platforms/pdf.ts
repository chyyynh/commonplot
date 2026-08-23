import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { PersistResolvedResourceTarget, ResourcePdfParseIdentity } from '@app-domain/resource-graph-contracts';
import { canonicalPaperUrl, paperIdentityFromIdentifiers } from '@core-shared/paper-identity';
import { isPaperIdentifier, type ResourceCreator, type ResourceKindMetadata } from '@core-shared/resource';
import { connectCoreDb } from '@db/connection';
import type { ResourceProcessingWorkflowPayload } from '../processing-jobs';
import { loadStoredPdfInput, markStoredBlobProcessingFailed, type StoredPdfInput } from '../stored-resource';
import { parsePdfWithLiteParse } from './liteparse';
import type { GenericAcquiredMaterial, ResolvedResource } from './materialize';
import { detectPdfEnhancementPages } from './pdf-enhancement';
import type { PdfWorkingDocumentV1 } from './pdf-working-document';

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

export type StoredPdfAcquisition = Readonly<{
	material: GenericAcquiredMaterial;
	resource: StoredPdfInput;
	complete(originalTranslationRevision: string | null): Promise<void>;
}>;

type StoredPdfTarget = Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'storedBlob' }>;

function parseIdentity(target: StoredPdfTarget): ResourcePdfParseIdentity {
	return {
		parseRunId: target.parseAdmission.parseRunId,
		fileResourceId: target.parseAdmission.fileResourceId,
		inputContentHash: target.parseAdmission.inputContentHash,
	};
}

function localParseSummary(document: PdfWorkingDocumentV1) {
	return {
		totalPages: document.totalPages,
		usablePages: document.quality.usablePages,
		problemPages: document.quality.problemPages,
		qualityReasons: [...new Set(detectPdfEnhancementPages(document).flatMap((page) => page.reasons))].sort(),
	};
}

async function parsePdfBytes(bytes: Uint8Array, source: string): Promise<PdfWorkingDocumentV1> {
	const result = await parsePdfWithLiteParse(bytes);
	if (!result.markdown) throw new NonRetryableError(`${source} has no usable text; OCR is required`);
	return result;
}

async function acquireStoredPdf(
	env: CoreEnv,
	resource: StoredPdfAcquisitionInput,
): Promise<Readonly<{ material: GenericAcquiredMaterial; workingDocument: PdfWorkingDocumentV1 }>> {
	if (resource.fileType !== PDF_MIME) {
		throw new Error(`Stored resource ${resource.resourceId} is not an R2 PDF`);
	}
	const obj = await env.R2.get(resource.storageKey);
	if (!obj) throw new Error(`PDF source object missing: ${resource.storageKey}`);
	if (obj.size > MAX_PDF_BYTES) throw new Error(`PDF source object exceeded ${MAX_PDF_BYTES} bytes`);
	const workingDocument = await parsePdfBytes(new Uint8Array(await obj.arrayBuffer()), `Stored PDF ${resource.resourceId}`);
	return {
		material: {
			resourcePlatform: null,
			fileType: PDF_MIME,
			title: resource.title,
			markdown: workingDocument.markdown,
			source: resource.source,
			originalLang: resource.originalLang,
			publishedDate: resource.publishedDate,
			summary: resource.summary,
			creators: resource.creators,
			kindMetadata: resource.kindMetadata,
		},
		workingDocument,
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
	const markdown = (await parsePdfBytes(await new Response(body).bytes(), `PDF ${finalUrl}`)).markdown;
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

export async function stageStoredPdfAcquisition(env: CoreEnv, step: WorkflowStep, target: StoredPdfTarget): Promise<StoredPdfAcquisition> {
	const identity = parseIdentity(target);
	const resource = await step.do(
		'load-stored-pdf-input-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => loadStoredPdfInput(await connectCoreDb(env), target.resourceId),
		{
			rollback: async () => {
				await Promise.all([
					markStoredBlobProcessingFailed(await connectCoreDb(env), target.resourceId),
					env.DOMAIN.failResourcePdfParse({ ...identity, errorCode: 'workflow_failed' }),
				]);
			},
			rollbackConfig: {
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
		},
	);
	if (resource.resourceId !== identity.fileResourceId || resource.contentHash !== identity.inputContentHash) {
		throw new NonRetryableError('Stored PDF no longer matches its admitted parse run');
	}
	await step.do(
		'start-stored-pdf-parse-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => {
			if (!(await env.DOMAIN.startResourcePdfParse(identity))) {
				throw new Error('App did not start the admitted PDF parse run');
			}
		},
		{
			rollback: async () => {
				await env.DOMAIN.failResourcePdfParse({ ...identity, errorCode: 'workflow_failed' });
			},
			rollbackConfig: {
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
		},
	);
	const contentStream = await step.do(
		'acquire-stored-pdf-v2',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await acquireStoredPdf(env, resource)).body!,
	);
	const acquired = await new Response(contentStream).json<
		Readonly<{ material: GenericAcquiredMaterial; workingDocument: PdfWorkingDocumentV1 }>
	>();
	await step.do(
		'record-local-pdf-parse-v1',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		async () => {
			if (!(await env.DOMAIN.recordLocalResourcePdfParse({ ...identity, ...localParseSummary(acquired.workingDocument) }))) {
				throw new Error('App did not record the local PDF parse result');
			}
		},
	);
	return {
		material: acquired.material,
		resource,
		complete: async (originalTranslationRevision) => {
			await step.do(
				'complete-pdf-parse-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					if (!(await env.DOMAIN.completeResourcePdfParse({ ...identity, originalTranslationRevision }))) {
						throw new Error('App did not complete the PDF parse run');
					}
				},
			);
		},
	};
}

export function storedPdfProcessingResult(
	resource: ResolvedResource,
	input: { resourceId: string },
): { resource: ResolvedResource; persistenceTarget: PersistResolvedResourceTarget } {
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
