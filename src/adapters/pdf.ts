import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ReadDocument } from '../contracts/acquired-resource';
import { paperIdentifiersFromIdentity, paperIdentityFromText } from '../contracts/paper-identity';
import { PDF_MIME } from '../contracts/pdf-policy';
import { stepJson } from '../services/workflow-step';
import { parseStoredPdfRepresentation } from '../services/zotero-sdt-service.ts';

const PDF_PARSE_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' } as const;

type PdfBody = Pick<Awaited<ReturnType<typeof parseStoredPdfRepresentation>>, 'markdown' | 'references' | 'paperIdentifierText' | 'title'>;

/** A stored PDF to read: an owned upload has no URL, a fetched one keeps where it was fetched from. */
export type PdfSource = Readonly<{
	url: string | null;
	fileName: string | null;
	inputContentHash: string;
	pdfStorageKey: string;
	sourceLabel: string;
	cropUrlPrefix: string;
}>;

/**
 * Zotero reads the body of every PDF. Its first page and its own properties are where it prints its DOI or arXiv id and
 * its title; without a printed title it is titled by its file name.
 */
export async function stagePdfDocument(env: CoreEnv, step: WorkflowStep, pdf: PdfSource): Promise<ReadDocument> {
	const body = await stepJson(
		step,
		`parse-pdf-body-v2-${pdf.url ? pdf.pdfStorageKey : 'stored'}`,
		PDF_PARSE_STEP,
		async (): Promise<PdfBody> => {
			const { markdown, references, paperIdentifierText, title } = await parseStoredPdfRepresentation(env, pdf);
			return { markdown, references, paperIdentifierText, title };
		},
	);
	if (!body.markdown) throw new NonRetryableError(`${pdf.sourceLabel} has no usable text; OCR is required`);
	const name = pdf.fileName?.trim() || 'PDF';
	const printedIdentity = paperIdentityFromText(body.paperIdentifierText);
	return {
		url: pdf.url,
		title: body.title ?? (name.replace(/\.[a-z0-9]{1,8}$/i, '') || name),
		source: pdf.url ? new URL(pdf.url).hostname.replace(/^www\./, '') : 'File',
		printed: { identifiers: printedIdentity ? paperIdentifiersFromIdentity(printedIdentity) : [], title: body.title },
		fileType: PDF_MIME,
		pdfHash: pdf.inputContentHash,
		content: body.markdown,
		references: body.references,
		// Core analysis replaces this BCP-47 undetermined marker.
		originalLang: 'und',
		subjectUrl: null,
		previewImageUrl: null,
		publishedDate: null,
		summary: null,
		creators: [],
		kindMetadata: null,
	};
}
