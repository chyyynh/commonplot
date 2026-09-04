import {
	type NormalizedStructuredPdf,
	normalizeStructuredPdf,
	parseStructuredPdfDocumentJson,
	parseStructuredPdfFailure,
	type StructuredPdfDocument,
	structuredPdfStorageKey,
	ZOTERO_SDT_ARTIFACT_VERSION,
	ZOTERO_SDT_CONTENT_TYPE,
	ZOTERO_SDT_MAX_RESPONSE_BYTES,
} from './zotero-sdt.ts';
import { ZOTERO_SDT_CONTAINER_NAME } from './zotero-sdt-container.ts';

const INPUT_HASH_PATTERN = /^[a-f\d]{64}$/u;
const MAX_ERROR_BODY_BYTES = 4_096;

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

function artifactFromJson(json: string): StructuredPdfArtifact {
	const document = parseStructuredPdfDocumentJson(json);
	return { document, json, normalized: normalizeStructuredPdf(document) };
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
