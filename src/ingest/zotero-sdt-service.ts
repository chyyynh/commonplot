import {
	parseStructuredPdfDocumentJson,
	parseStructuredPdfFailure,
	type StructuredPdfDocument,
	type StructuredPdfSourceCrop,
	structuredPdfStorageKey,
	ZOTERO_SDT_ARTIFACT_VERSION,
	ZOTERO_SDT_CONTAINER_NAME,
	ZOTERO_SDT_CONTENT_TYPE,
	ZOTERO_SDT_MAX_RESPONSE_BYTES,
} from './zotero-sdt.ts';

const INPUT_HASH_PATTERN = /^[a-f\d]{64}$/u;
const MAX_ERROR_BODY_BYTES = 4_096;
const MAX_SOURCE_CROP_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
}>;

export type StructuredPdfSourceCropInventory = Readonly<{
	crops: readonly StructuredPdfSourceCrop[];
	inputContentHash: string;
	pdfStorageKey: string;
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

function isPng(bytes: Uint8Array): boolean {
	return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((part, index) => bytes[index] === part);
}

async function sourceCropPng(response: Response): Promise<Uint8Array> {
	const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
	if (contentType !== 'image/png') {
		await response.body?.cancel('Zotero source crop response is not a PNG');
		throw new Error('Zotero source crop response is not a PNG');
	}
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_CROP_BYTES) {
		await response.body?.cancel('Zotero source crop response exceeded byte limit');
		throw new Error('Zotero source crop response size is invalid');
	}
	const png = new Uint8Array(await response.arrayBuffer());
	if (png.byteLength < 1 || png.byteLength > MAX_SOURCE_CROP_BYTES) throw new Error('Zotero source crop response size is invalid');
	if (!isPng(png)) throw new Error('Zotero source crop response has an invalid PNG signature');
	return png;
}

function artifactFromJson(json: string): StructuredPdfArtifact {
	const document = parseStructuredPdfDocumentJson(json);
	return { document, json };
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

/** Return the expected crop IDs already materialized as valid R2 artifacts. */
export async function readReadyStructuredPdfSourceCropIds(env: CoreEnv, input: StructuredPdfSourceCropInventory): Promise<string[]> {
	if (!INPUT_HASH_PATTERN.test(input.inputContentHash)) throw new TypeError('Structured PDF input content hash is invalid');
	if (!input.crops.length) return [];
	const prefix = `${input.pdfStorageKey}.structured-crops/${input.inputContentHash}/`;
	const inventory = await env.R2.list({ include: ['customMetadata'], limit: 1_000, prefix });
	if (inventory.truncated) throw new Error('Structured PDF source crop inventory exceeded the bounded prefix');
	const objectsByKey = new Map(inventory.objects.map((object) => [object.key, object]));
	return input.crops.flatMap((crop) => {
		const storageKey = structuredPdfSourceCropStorageKey(input.pdfStorageKey, input.inputContentHash, crop.id);
		return reusableSourceCrop(objectsByKey.get(storageKey) ?? null, input.inputContentHash, crop) ? [crop.id] : [];
	});
}

/** Materialize Zotero Reading Mode source crops beside the private PDF. */
export async function ensureStructuredPdfSourceCrops(
	env: CoreEnv,
	input: Readonly<{
		crops: readonly StructuredPdfSourceCrop[];
		inputContentHash: string;
		pdfStorageKey: string;
		resourceId: string;
	}>,
): Promise<string[]> {
	if (!INPUT_HASH_PATTERN.test(input.inputContentHash)) throw new TypeError('Structured PDF input content hash is invalid');
	let readyCropIds: Set<string>;
	try {
		readyCropIds = new Set(await readReadyStructuredPdfSourceCropIds(env, input));
	} catch (error) {
		readyCropIds = new Set();
		console.warn({
			tag: 'PDF_PARSE',
			event: 'zotero_source_crop_inventory_failed',
			resource_id: input.resourceId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	for (const crop of input.crops) {
		const storageKey = structuredPdfSourceCropStorageKey(input.pdfStorageKey, input.inputContentHash, crop.id);
		try {
			if (readyCropIds.has(crop.id)) continue;
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
			const png = await sourceCropPng(response);
			await env.R2.put(storageKey, png, {
				customMetadata: {
					artifactVersion: SOURCE_CROP_ARTIFACT_VERSION,
					inputSha256: input.inputContentHash,
					sourceCropId: crop.id,
				},
				httpMetadata: { contentType: 'image/png' },
			});
			readyCropIds.add(crop.id);
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
		crop_count: input.crops.length,
		ready_count: readyCropIds.size,
		resource_id: input.resourceId,
	});
	return input.crops.flatMap((crop) => (readyCropIds.has(crop.id) ? [crop.id] : []));
}

export async function parsePdfWithZotero(
	env: CoreEnv,
	input: ReadableStream<Uint8Array>,
	byteLength: number | null,
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
	return artifactFromJson(await object.text());
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
