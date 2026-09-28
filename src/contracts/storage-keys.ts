/**
 * R2 key layout for PDF derivatives. Web serves owned crops through
 * `web-tanstack/src/server/storage/keys.server.ts`; change both together.
 */
export function structuredPdfDocumentKey(pdfStorageKey: string): string {
	return `${pdfStorageKey}.structured-document.json`;
}

export function structuredPdfCropPrefix(pdfStorageKey: string, inputContentHash: string): string {
	return `${pdfStorageKey}.structured-crops/${inputContentHash}/`;
}

/** Content-addressed corpus copy of an independently fetched public PDF. */
export function publicPdfPrefix(sourceHash: string, inputContentHash: string): string {
	return `public-pdf/${sourceHash}/${inputContentHash}`;
}

export function publicPdfSourceKey(sourceHash: string, inputContentHash: string): string {
	return `${publicPdfPrefix(sourceHash, inputContentHash)}/source.pdf`;
}
