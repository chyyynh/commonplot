import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { AcquiredResource, AcquisitionInput } from '../contracts/acquired-resource';
import { paperIdentifiersFromIdentity, paperIdentityFromText } from '../contracts/paper-identity';
import { PDF_MIME } from '../contracts/pdf-policy';
import { blobKey, storedPdfCropUrlPrefix } from '../contracts/storage-keys';
import { stepJson } from '../services/workflow-step';
import { parseStoredPdfRepresentation, type storePublicPdfResponse } from '../services/zotero-sdt-service.ts';

const PDF_PARSE_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' } as const;

type PdfBody = Pick<Awaited<ReturnType<typeof parseStoredPdfRepresentation>>, 'markdown' | 'references' | 'paperIdentifierText'>;

/** Zotero reads the body of every PDF. */
async function stagePdfBody(
	env: CoreEnv,
	step: WorkflowStep,
	input: Readonly<{ stepKey: string; pdfStorageKey: string; inputContentHash: string; sourceLabel: string; cropUrlPrefix: string }>,
): Promise<PdfBody> {
	return stepJson(step, `parse-pdf-body-v1-${input.stepKey}`, PDF_PARSE_STEP, async (): Promise<PdfBody> => {
		const { markdown, references, paperIdentifierText } = await parseStoredPdfRepresentation(env, input);
		return { markdown, references, paperIdentifierText };
	});
}

/** What every PDF file Resource shares: its parsed body, and no platform, subject, date or creators. */
function pdfFileResource(pdfHash: string, body: PdfBody) {
	return {
		kind: 'file',
		subjectUrl: null,
		previewImageUrl: null,
		resourcePlatform: null,
		fileType: PDF_MIME,
		pdfHash,
		content: body.markdown,
		references: body.references,
		publishedDate: null,
		summary: null,
		creators: [],
		kindMetadata: null,
	} satisfies Partial<AcquiredResource>;
}

export async function stagePublicPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	source: Awaited<ReturnType<typeof storePublicPdfResponse>>,
): Promise<AcquiredResource & { kind: 'file'; resourcePlatform: null; url: string }> {
	const url = new URL(source.url);
	let fileName = url.pathname.split('/').filter(Boolean).at(-1) || 'document.pdf';
	try {
		fileName = decodeURIComponent(fileName) || 'document.pdf';
	} catch {
		// Keep a malformed path segment in its encoded form.
	}
	const title = fileName.replace(/\.[a-z0-9]+$/i, '').trim();
	if (!title) throw new NonRetryableError(`File name has no title: ${fileName}`);
	const parsed = await stagePdfBody(env, step, { ...source, stepKey: source.pdfStorageKey });
	if (!parsed.markdown) throw new NonRetryableError('Fetched PDF has no usable text; OCR is required');
	return {
		...pdfFileResource(source.inputContentHash, parsed),
		resourceIdentifiers: [],
		url: source.url,
		title,
		source: url.hostname.replace(/^www\./, ''),
		originalLang: 'und',
	};
}

export async function stageStoredPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	target: Extract<AcquisitionInput, { kind: 'storedPdf' }>,
): Promise<AcquiredResource & { kind: 'file'; resourcePlatform: null; titlePageText: string | null }> {
	const { contentHash, fileName } = target.pdf;
	const parsed = await stagePdfBody(env, step, {
		stepKey: 'stored',
		pdfStorageKey: blobKey(contentHash),
		inputContentHash: contentHash,
		sourceLabel: `Stored PDF ${target.objectId}`,
		cropUrlPrefix: storedPdfCropUrlPrefix(contentHash),
	});
	// An unidentified upload is titled by its file name, as Web titles a new upload.
	const name = fileName?.trim() || 'PDF';
	// The first page and the PDF's own properties are where a paper prints its DOI or arXiv id.
	const printedIdentity = paperIdentityFromText(parsed.paperIdentifierText);
	if (!parsed.markdown) throw new NonRetryableError(`Stored PDF ${target.objectId} has no usable text; OCR is required`);
	return {
		...pdfFileResource(contentHash, parsed),
		resourceIdentifiers: printedIdentity ? paperIdentifiersFromIdentity(printedIdentity) : [],
		titlePageText: parsed.paperIdentifierText,
		url: null,
		title: name.replace(/\.[a-z0-9]{1,8}$/i, '') || name,
		source: 'File',
		// Core analysis replaces this BCP-47 undetermined marker, as for a new upload.
		originalLang: 'und',
	};
}
