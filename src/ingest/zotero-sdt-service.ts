import { readBoundedResponseText } from '../shared/response.ts';
import {
	parseStructuredPdfDocumentJson,
	parseStructuredPdfFailure,
	type StructuredPdfDocument,
	type StructuredPdfSourceCrop,
	structuredPdfStorageKey,
	ZOTERO_SDT_ARTIFACT_VERSION,
} from './zotero-sdt.ts';

const MAX_ERROR_BODY_BYTES = 4_096;
const SOURCE_CROP_ARTIFACT_VERSION = 'newsence-zotero-source-crop-v1';
const ZOTERO_SDT_CONTAINER_NAME = 'structured-pdf-v1';
const ZOTERO_SDT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class ZoteroSdtParseError extends Error {
	readonly totalPages: number | null;

	constructor(message: string, totalPages: number | null) {
		super(message);
		this.totalPages = totalPages;
	}
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
): Promise<StructuredPdfSourceCrop[]> {
	const prefix = `${input.pdfStorageKey}.structured-crops/${input.inputContentHash}/`;
	const readyCropIds = new Set<string>();
	try {
		if (input.crops.length) {
			const inventory = await env.R2.list({ include: ['customMetadata'], limit: 1_000, prefix });
			if (inventory.truncated) throw new Error('Structured PDF source crop inventory exceeded the bounded prefix');
			for (const { customMetadata, key } of inventory.objects) {
				if (customMetadata?.artifactVersion === SOURCE_CROP_ARTIFACT_VERSION) readyCropIds.add(key.slice(prefix.length, -4));
			}
		}
	} catch (error) {
		console.warn({
			tag: 'PDF_PARSE',
			event: 'zotero_source_crop_inventory_failed',
			resource_id: input.resourceId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	for (const crop of input.crops) {
		const storageKey = `${prefix}${crop.id}.png`;
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
				const body = await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES, 'Zotero source crop error');
				throw new Error(`Zotero source crop failed with ${response.status}: ${body}`);
			}
			if (!response.body) throw new Error('Zotero source crop response is empty');
			await env.R2.put(storageKey, response.body, {
				customMetadata: { artifactVersion: SOURCE_CROP_ARTIFACT_VERSION },
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
	return input.crops.filter((crop) => readyCropIds.has(crop.id));
}

export async function parsePdfWithZotero(
	env: CoreEnv,
	input: ReadableStream<Uint8Array>,
	byteLength: number | null,
): Promise<StructuredPdfDocument> {
	const response = await env.ZOTERO_SDT.getByName(ZOTERO_SDT_CONTAINER_NAME).processPdf(input, byteLength);
	const maxBytes = response.ok ? ZOTERO_SDT_MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES;
	const body = await readBoundedResponseText(response, maxBytes, 'Zotero SDT response');
	if (!response.ok) {
		const { message, totalPages } = parseStructuredPdfFailure(response.status, body);
		throw new ZoteroSdtParseError(message, totalPages);
	}
	return parseStructuredPdfDocumentJson(body);
}

export async function readStructuredPdfArtifact(
	env: CoreEnv,
	pdfStorageKey: string,
	inputContentHash: string,
): Promise<StructuredPdfDocument | null> {
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
	return parseStructuredPdfDocumentJson(await object.text());
}

export async function writeStructuredPdfArtifact(
	env: CoreEnv,
	pdfStorageKey: string,
	inputContentHash: string,
	document: StructuredPdfDocument,
): Promise<void> {
	await env.R2.put(structuredPdfStorageKey(pdfStorageKey), JSON.stringify(document), {
		customMetadata: {
			artifactVersion: ZOTERO_SDT_ARTIFACT_VERSION,
			inputSha256: inputContentHash,
		},
	});
}
