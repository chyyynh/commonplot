/**
 * R2 key layout, mirrored from `web-tanstack/src/server/storage/keys.server.ts`; change both together.
 * Bytes live once under their SHA-256: an upload and the public paper it became share one object.
 */
export function blobKey(contentHash: string): string {
	return `blobs/${contentHash}`;
}

export function structuredPdfDocumentKey(pdfStorageKey: string): string {
	return `${pdfStorageKey}.structured-document.json`;
}

export function structuredPdfCropPrefix(pdfStorageKey: string, inputContentHash: string): string {
	return `${pdfStorageKey}.structured-crops/${inputContentHash}/`;
}

/** Web serves a stored PDF and its crops by content hash, to its owners or, once a public paper reads it, to everyone. */
export function storedPdfCropUrlPrefix(contentHash: string): string {
	return `/api/media/files/${contentHash}?crop=`;
}
