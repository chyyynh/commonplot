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
const MAX_SOURCE_CROP_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_CROP_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_CROP_FRAME_METADATA_BYTES = 4_096;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SOURCE_CROP_BATCH_CONTENT_TYPE = 'application/vnd.newsence.pdf-crops';
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

class CropBatchReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private remainder: Uint8Array | null = null;

	constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
		this.reader = reader;
	}

	private async readChunk(maxLength: number): Promise<Uint8Array | null> {
		if (this.remainder?.byteLength) {
			const chunk = this.remainder.subarray(0, maxLength);
			this.remainder = this.remainder.byteLength > maxLength ? this.remainder.subarray(maxLength) : null;
			return chunk;
		}
		for (;;) {
			const { done, value } = await this.reader.read();
			if (done) return null;
			if (!value.byteLength) continue;
			const chunk = value.subarray(0, maxLength);
			this.remainder = value.byteLength > maxLength ? value.subarray(maxLength) : null;
			return chunk;
		}
	}

	async readExactly(byteLength: number): Promise<Uint8Array> {
		const result = new Uint8Array(byteLength);
		let offset = 0;
		while (offset < byteLength) {
			const chunk = await this.readChunk(byteLength - offset);
			if (!chunk) throw new Error('Zotero source crop batch ended unexpectedly');
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	}

	async expectEnd(): Promise<void> {
		if (await this.readChunk(1)) throw new Error('Zotero source crop batch has trailing bytes');
	}

	streamExactly(byteLength: number, prefix: Uint8Array | null = null): ReadableStream<Uint8Array> {
		let remaining = byteLength;
		let firstChunk = prefix;
		return new ReadableStream<Uint8Array>({
			cancel: (reason) => this.reader.cancel(reason),
			pull: async (controller) => {
				try {
					if (firstChunk) {
						controller.enqueue(firstChunk);
						firstChunk = null;
						if (!remaining) controller.close();
						return;
					}
					if (!remaining) {
						controller.close();
						return;
					}
					const chunk = await this.readChunk(remaining);
					if (!chunk) throw new Error('Zotero source crop payload ended unexpectedly');
					remaining -= chunk.byteLength;
					controller.enqueue(chunk);
					if (!remaining) controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
		});
	}

	cancel(reason: string): Promise<void> {
		return this.reader.cancel(reason);
	}
}

type CropBatchFrame = Readonly<{
	byteLength: number;
	error: string | null;
	fatal: boolean;
	id: string | null;
}>;

function parseCropBatchFrame(bytes: Uint8Array): CropBatchFrame {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error('Zotero source crop batch metadata is invalid JSON');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Zotero source crop batch metadata is invalid');
	const id = 'id' in value && (typeof value.id === 'string' || value.id === null) ? value.id : undefined;
	const byteLength = 'byteLength' in value ? value.byteLength : undefined;
	const error = 'error' in value && typeof value.error === 'string' ? value.error.slice(0, 500) : null;
	const fatal = 'fatal' in value && value.fatal === true;
	if (
		id === undefined ||
		!Number.isInteger(byteLength) ||
		typeof byteLength !== 'number' ||
		byteLength < 0 ||
		byteLength > MAX_SOURCE_CROP_BYTES ||
		(id === null && !fatal) ||
		(id !== null && !/^\d+(?:\.\d+)*-p\d+$/u.test(id)) ||
		(byteLength === 0 && !error) ||
		(byteLength > 0 && (error || fatal))
	) {
		throw new Error('Zotero source crop batch metadata is invalid');
	}
	return { byteLength, error, fatal, id };
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
	const missingCrops = input.crops.filter((crop) => !readyCropIds.has(crop.id));
	if (missingCrops.length) {
		let batchReader: CropBatchReader | null = null;
		try {
			const pdf = await env.R2.get(input.pdfStorageKey);
			if (!pdf) throw new Error('PDF source object is missing');
			const response = await env.ZOTERO_SDT.getByName(ZOTERO_SDT_CONTAINER_NAME).renderPdfAreas(pdf.body, pdf.size, missingCrops);
			if (!response.ok) {
				throw new Error(
					`Zotero source crop batch failed with ${response.status}: ${await boundedResponseText(response, MAX_ERROR_BODY_BYTES)}`,
				);
			}
			const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
			if (contentType !== SOURCE_CROP_BATCH_CONTENT_TYPE || !response.body) {
				await response.body?.cancel('Zotero source crop batch response is invalid');
				throw new Error('Zotero source crop batch response is invalid');
			}
			batchReader = new CropBatchReader(response.body.getReader());
			const cropsById = new Map(missingCrops.map((crop) => [crop.id, crop]));
			const seen = new Set<string>();
			let renderedBytes = 0;
			for (;;) {
				const prefix = await batchReader.readExactly(4);
				const metadataLength = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0);
				if (!metadataLength) {
					await batchReader.expectEnd();
					break;
				}
				if (metadataLength > MAX_SOURCE_CROP_FRAME_METADATA_BYTES) throw new Error('Zotero source crop batch metadata is too large');
				const frame = parseCropBatchFrame(await batchReader.readExactly(metadataLength));
				if (frame.fatal) throw new Error(frame.error ?? 'Zotero source crop batch failed');
				const crop = frame.id ? cropsById.get(frame.id) : null;
				if (!crop || seen.has(crop.id)) throw new Error('Zotero source crop batch returned an unexpected crop ID');
				seen.add(crop.id);
				if (!frame.byteLength) {
					console.warn({
						tag: 'PDF_PARSE',
						event: 'zotero_source_crop_failed',
						crop_id: crop.id,
						resource_id: input.resourceId,
						error: frame.error,
					});
					continue;
				}
				renderedBytes += frame.byteLength;
				if (renderedBytes > MAX_SOURCE_CROP_BATCH_BYTES) throw new Error('Zotero source crop batch is too large');
				const storageKey = structuredPdfSourceCropStorageKey(input.pdfStorageKey, input.inputContentHash, crop.id);
				if (frame.byteLength < PNG_SIGNATURE.byteLength) throw new Error('Zotero source crop payload is not a PNG');
				const signature = await batchReader.readExactly(PNG_SIGNATURE.byteLength);
				if (!PNG_SIGNATURE.every((byte, index) => signature[index] === byte)) {
					throw new Error('Zotero source crop payload has an invalid PNG signature');
				}
				const body = batchReader
					.streamExactly(frame.byteLength - signature.byteLength, signature)
					.pipeThrough(new FixedLengthStream(frame.byteLength));
				await env.R2.put(storageKey, body, {
					customMetadata: {
						artifactVersion: SOURCE_CROP_ARTIFACT_VERSION,
						inputSha256: input.inputContentHash,
						sourceCropId: crop.id,
					},
					httpMetadata: { contentType: 'image/png' },
				});
				readyCropIds.add(crop.id);
			}
			for (const crop of missingCrops) {
				if (!seen.has(crop.id)) throw new Error(`Zotero source crop batch omitted ${crop.id}`);
			}
		} catch (error) {
			await batchReader?.cancel('Zotero source crop batch processing failed').catch(() => undefined);
			console.warn({
				tag: 'PDF_PARSE',
				event: 'zotero_source_crop_batch_failed',
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
