/**
 * The R2 key layout, which Web imports too: nothing else builds a key. Bytes are stored once by content, so every
 * owner of the same bytes, and the public paper an upload became, share one object; `stored_objects` records owners.
 */
export const BLOB_KEY_PREFIX = 'blobs/';
export const STRUCTURED_DOCUMENT_SUFFIX = '.structured-document.json';
export const STRUCTURED_CROPS_SUFFIX = '.structured-crops/';

/** `name` is the SHA-256 of the bytes, or the object id of a streamed file. */
export function blobKey(name: string): string {
	return `${BLOB_KEY_PREFIX}${name}`;
}

/** Core's parsed-document derivative of a stored PDF. */
export function structuredPdfDocumentKey(pdfKey: string): string {
	return `${pdfKey}${STRUCTURED_DOCUMENT_SUFFIX}`;
}

/** Core's figure crops for a stored PDF; the whole prefix belongs to the PDF. */
export function structuredPdfCropPrefix(pdfKey: string): string {
	return `${pdfKey}${STRUCTURED_CROPS_SUFFIX}`;
}

export function structuredPdfCropKey(pdfKey: string, contentHash: string, cropId: string): string {
	return `${structuredPdfCropPrefix(pdfKey)}${contentHash}/${cropId}.png`;
}

/** Web serves a stored PDF and its crops by content hash, to its owners or, once a public paper reads it, to everyone. */
export function storedPdfCropUrlPrefix(contentHash: string): string {
	return `/api/media/files/${contentHash}?crop=`;
}

export const PDF_MIME = 'application/pdf';

/**
 * The advisory lock namespace a blob's key is locked under (`pg_advisory_xact_lock(namespace, hashtext(key))`): Web purges
 * a blob only while holding it and finding nothing that reads the blob, and Core holds it to commit a Resource that does.
 */
export const BLOB_LOCK_NAMESPACE = 330571;
