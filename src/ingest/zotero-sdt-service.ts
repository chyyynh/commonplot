import {
	type NormalizedStructuredPdf,
	normalizeStructuredPdf,
	parseStructuredPdfDocumentJson,
	parseStructuredPdfFailure,
	type StructuredPdfDocument,
	type StructuredPdfSourceCrop,
	structuredPdfSourceCrops,
	structuredPdfStorageKey,
	ZOTERO_SDT_ARTIFACT_VERSION,
	ZOTERO_SDT_CONTENT_TYPE,
	ZOTERO_SDT_MAX_RESPONSE_BYTES,
} from './zotero-sdt.ts';
import { ZOTERO_SDT_CONTAINER_NAME } from './zotero-sdt-container.ts';

const INPUT_HASH_PATTERN = /^[a-f\d]{64}$/u;
const MAX_ERROR_BODY_BYTES = 4_096;
const MAX_SOURCE_CROP_BYTES = 8 * 1024 * 1024;
const SOURCE_CROP_ARTIFACT_VERSION = 'newsence-zotero-source-crop-v1';

export class ZoteroSdtParseError extends Error {
	readonly totalPages: number | null;

	constructor(message: string, totalPages: number | null) {
		super(message);
		this.name = 'ZoteroSdtParseError';
		this.totalPages = totalPages;
	}
}

export type StructuredPdfArtifact = Readonly<{
	document: StructuredPdfDocument;
	json: string;
	normalized: NormalizedStructuredPdf;
}>;

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel('Zotero SDT response exceeded byte limit');
		throw new Error(`Zotero SDT response exceeded ${maxBytes} bytes`);
	}
	if (!response.body) throw new Error('Zotero SDT response body is missing');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let byteLength = 0;
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		byteLength += value.byteLength;
		if (byteLength > maxBytes) {
			await reader.cancel('Zotero SDT response exceeded byte limit');
			throw new Error(`Zotero SDT response exceeded ${maxBytes} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function artifactFromJson(json: string, inputContentHash?: string): StructuredPdfArtifact {
	const document = parseStructuredPdfDocumentJson(json);
	return { document, json, normalized: normalizeStructuredPdf(document, { inputContentHash }) };
}

export function structuredPdfSourceCropStorageKey(pdfStorageKey: string, inputContentHash: string, cropId: string): string {
	if (!INPUT_HASH_PATTERN.test(inputContentHash)) throw new TypeError('Structured PDF input content hash is invalid');
	if (!/^\d+(?:\.\d+)*-p\d+$/u.test(cropId)) throw new TypeError('Structured PDF source crop ID is invalid');
	return `${pdfStorageKey}.structured-crops/${inputContentHash}/${cropId}.png`;
}

function reusableSourceCrop(object: R2Object | null, inputContentHash: string, crop: StructuredPdfSourceCrop): boolean {
	return (
		object?.customMetadata?.artifactVersion === SOURCE_CROP_ARTIFACT_VERSION &&
		object.customMetadata.inputSha256 === inputContentHash &&
		object.customMetadata.sourceCropId === crop.id &&
		object.size > 0 &&
		object.size <= MAX_SOURCE_CROP_BYTES
	);
}

/** Materialize Zotero Reading Mode source crops beside the private PDF. */
export async function ensureStructuredPdfSourceCrops(
	env: CoreEnv,
	input: Readonly<{
		document: StructuredPdfDocument;
		inputContentHash: string;
		pdfStorageKey: string;
		resourceId: string;
	}>,
): Promise<void> {
	if (!INPUT_HASH_PATTERN.test(input.inputContentHash)) throw new TypeError('Structured PDF input content hash is invalid');
	const crops = structuredPdfSourceCrops(input.document);
	let ready = 0;
	for (const crop of crops) {
		const storageKey = structuredPdfSourceCropStorageKey(input.pdfStorageKey, input.inputContentHash, crop.id);
		try {
			if (reusableSourceCrop(await env.R2.head(storageKey), input.inputContentHash, crop)) {
				ready += 1;
				continue;
			}
			const pdf = await env.R2.get(input.pdfStorageKey);
			if (!pdf) throw new Error('PDF source object is missing');
			const response = await env.ZOTERO_SDT.getByName(ZOTERO_SDT_CONTAINER_NAME).renderPdfArea(
				pdf.body,
				pdf.size,
				crop.pageIndex,
				crop.rect,
			);
			if (!response.ok) {
				throw new Error(`Zotero source crop failed with ${response.status}: ${await boundedResponseText(response, MAX_ERROR_BODY_BYTES)}`);
			}
			const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
			const contentLength = Number(response.headers.get('content-length'));
			if (contentType !== 'image/png' || !Number.isInteger(contentLength) || contentLength < 1 || contentLength > MAX_SOURCE_CROP_BYTES) {
				await response.body?.cancel('Zotero source crop response is invalid');
				throw new Error('Zotero source crop response is invalid');
			}
			if (!response.body) throw new Error('Zotero source crop response body is missing');
			await env.R2.put(storageKey, response.body, {
				customMetadata: {
					artifactVersion: SOURCE_CROP_ARTIFACT_VERSION,
					inputSha256: input.inputContentHash,
					sourceCropId: crop.id,
				},
				httpMetadata: { contentType: 'image/png' },
			});
			ready += 1;
		} catch (error) {
			console.warn({
				tag: 'PDF_PARSE',
				event: 'zotero_source_crop_failed',
				crop_id: crop.id,
				resource_id: input.resourceId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	console.info({
		tag: 'PDF_PARSE',
		event: 'zotero_source_crops_completed',
		crop_count: crops.length,
		ready_count: ready,
		resource_id: input.resourceId,
	});
}

export async function parsePdfWithZotero(
	env: CoreEnv,
	input: ReadableStream<Uint8Array>,
	byteLength: number,
): Promise<StructuredPdfArtifact> {
	const response = await env.ZOTERO_SDT.getByName(ZOTERO_SDT_CONTAINER_NAME).processPdf(input, byteLength);
	if (!response.ok) {
		const body = await boundedResponseText(response, MAX_ERROR_BODY_BYTES);
		const { message, totalPages } = parseStructuredPdfFailure(response.status, body);
		throw new ZoteroSdtParseError(message, totalPages);
	}
	return artifactFromJson(await boundedResponseText(response, ZOTERO_SDT_MAX_RESPONSE_BYTES));
}

export async function readStructuredPdfArtifact(
	env: CoreEnv,
	pdfStorageKey: string,
	inputContentHash: string,
): Promise<StructuredPdfArtifact | null> {
	if (!INPUT_HASH_PATTERN.test(inputContentHash)) throw new TypeError('Structured PDF input content hash is invalid');
	const object = await env.R2.get(structuredPdfStorageKey(pdfStorageKey));
	if (!object) return null;
	if (object.customMetadata?.artifactVersion !== ZOTERO_SDT_ARTIFACT_VERSION || object.customMetadata?.inputSha256 !== inputContentHash) {
		await object.body.cancel('Structured PDF artifact revision is stale');
		return null;
	}
	if (object.size < 1 || object.size > ZOTERO_SDT_MAX_RESPONSE_BYTES) {
		await object.body.cancel('Structured PDF artifact size is invalid');
		throw new Error('Structured PDF artifact size is invalid');
	}
	return artifactFromJson(await object.text(), inputContentHash);
}

export async function writeStructuredPdfArtifact(
	env: CoreEnv,
	pdfStorageKey: string,
	inputContentHash: string,
	artifact: StructuredPdfArtifact,
): Promise<void> {
	if (!INPUT_HASH_PATTERN.test(inputContentHash)) throw new TypeError('Structured PDF input content hash is invalid');
	await env.R2.put(structuredPdfStorageKey(pdfStorageKey), artifact.json, {
		customMetadata: {
			artifactVersion: ZOTERO_SDT_ARTIFACT_VERSION,
			inputSha256: inputContentHash,
			processorVersion: String(artifact.document.metadata.processor.version),
			schemaVersion: artifact.document.schemaVersion,
			sourceMd5: artifact.document.metadata.source.hash,
		},
		httpMetadata: { contentType: ZOTERO_SDT_CONTENT_TYPE },
	});
}
