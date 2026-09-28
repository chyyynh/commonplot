import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { AcquiredResource, AcquisitionInput } from '../contracts/acquired-resource';
import { paperIdentifiersFromIdentity, paperIdentityFromText } from '../contracts/paper-identity';
import { PDF_MIME, type PaidPdfFallbackGrant } from '../contracts/pdf-policy';
import { stagePaidLlamaParseFallback } from '../services/llamaparse';
import { parseStoredPdfRepresentation, type storePublicPdfResponse } from '../services/zotero-sdt-service.ts';

type PdfAcquisition = Readonly<{
	resource: AcquiredResource & { kind: 'file'; resourcePlatform: null; url: string };
}>;

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
	target: Extract<AcquisitionInput, { kind: 'storedPdf' }>,
	processingId: string,
): Promise<AcquiredResource & { kind: 'file'; resourcePlatform: null; titlePageText: string | null }> {
	const resource = target.pdf;
	const parsed = await stagePdfBody(env, step, {
		stepKey: 'stored',
		pdfStorageKey: resource.storageKey,
		inputContentHash: resource.contentHash,
		sourceLabel: `Stored PDF ${target.resourceId}`,
	});
	// The first page and the PDF's own properties are where a paper prints its DOI or arXiv id.
	const printedIdentity = paperIdentityFromText(parsed.paperIdentifierText);
	const cloudMarkdown = await stagePaidLlamaParseFallback(env, step, {
		grant: target.paidPdfFallback,
		local: parsed.parse,
		processingId,
		source: {
			kind: 'private-upload',
			storageKey: resource.storageKey,
		},
	});
	if (!cloudMarkdown && !parsed.markdown)
		throw new NonRetryableError(`Stored PDF ${target.resourceId} has no usable text; OCR is required`);
	return {
		kind: 'file',
		resourceIdentifiers: printedIdentity ? paperIdentifiersFromIdentity(printedIdentity) : [],
		titlePageText: parsed.paperIdentifierText,
		subjectUrl: null,
		previewImageUrl: null,
		resourcePlatform: null,
		fileType: PDF_MIME,
		url: null,
		title: resource.title,
		content: cloudMarkdown || parsed.markdown,
		references: cloudMarkdown ? [] : parsed.references,
		source: resource.source,
		originalLang: resource.originalLang,
		publishedDate: resource.publishedDate,
		summary: resource.summary,
		creators: resource.creators,
		kindMetadata: null,
	};
}
