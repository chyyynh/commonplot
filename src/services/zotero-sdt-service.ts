import { Buffer } from 'node:buffer';
import { hash } from 'node:crypto';
import { DurableObject, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ReadDocument } from '../contracts/acquired-resource.ts';
import { paperIdentityFromText } from '../contracts/paper-identity.ts';
import { blobKey, storedPdfCropUrlPrefix, structuredPdfCropKey, structuredPdfDocumentKey, PDF_MIME } from '../contracts/storage-keys.ts';
import { coreExports } from '../exports.ts';
import { errorMessage, limitByteStream, readBoundedResponseText, statusError } from './response.ts';
import { stepJson } from './workflow-step.ts';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
import {
	normalizeStructuredPdf,
	parseStructuredPdfDocumentJson,
	type StructuredPdfDocument,
	type StructuredPdfSourceCrop,
	ZOTERO_SDT_ARTIFACT_VERSION,
} from './zotero-sdt.ts';

const MAX_ERROR_BODY_BYTES = 4_096;
const SOURCE_CROP_ARTIFACT_VERSION = 'newsence-zotero-source-crop-v2';
const ZOTERO_SDT_CONTAINER_NAME = 'structured-pdf-v1';
const ZOTERO_SDT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const CROP_BATCH_SIZE = 8;
const MAX_CROP_PNG_BYTES = 8 * 1024 * 1024;
const MAX_CROP_ROW_BYTES = Math.ceil(MAX_CROP_PNG_BYTES / 3) * 4 + 4_096;
const PDF_PARSE_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' } as const;

function structuredPdfFailureMessage(status: number, body: string): string {
	const message = `Zotero SDT parse failed with ${status}`;
	try {
		const { error } = JSON.parse(body) as { error?: unknown };
		if (typeof error === 'string' && error.trim()) return `${message}: ${error.trim()}`;
	} catch {
		// A malformed internal error response keeps the status-only message.
	}
	return message;
}

function cropFailure(error: unknown) {
	return {
		reason: errorMessage(error).slice(0, MAX_ERROR_BODY_BYTES),
		retryable: !(error instanceof NonRetryableError),
	};
}

/** A source deleted during rendering must not leave newly written orphan derivatives. */
async function putPdfDerivative(
	env: CoreEnv,
	pdfStorageKey: string,
	key: string,
	value: string | Buffer,
	options: R2PutOptions,
): Promise<void> {
	await env.R2.put(key, value, options);
	// Check after the write: if deletion races before it, remove our late object;
	// if deletion starts after this check, its family scan sees our existing object.
	if (!(await env.R2.head(pdfStorageKey))) {
		await env.R2.delete(key);
		throw new NonRetryableError('PDF source was removed during processing');
	}
}

/** Keep only one bounded PNG row in memory while the container streams a batch. */
async function* cropResponseRows(response: Response): AsyncGenerator<unknown> {
	if (!response.body) throw new Error('Zotero crop batch response is empty');
	const stream = limitByteStream(response.body, CROP_BATCH_SIZE * MAX_CROP_ROW_BYTES, () => new Error('Zotero crop batch is too large'));
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	let pending = '';
	let finished = false;
	try {
		while (!finished) {
			const { done, value } = await reader.read();
			finished = done;
			pending += decoder.decode(value, { stream: !done });
			for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
				if (newline > MAX_CROP_ROW_BYTES) throw new Error('Zotero crop row is too large');
				const row = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (row.trim()) yield JSON.parse(row);
			}
			if (pending.length > MAX_CROP_ROW_BYTES) throw new Error('Zotero crop row is too large');
		}
		if (pending.trim()) yield JSON.parse(pending);
	} finally {
		if (!finished) await reader.cancel('Crop batch consumer stopped').catch(() => undefined);
		reader.releaseLock();
	}
}

function cropPng(row: Record<string, unknown>): Buffer {
	if (typeof row.pngBase64 !== 'string' || !row.pngBase64.length || row.pngBase64.length > MAX_CROP_ROW_BYTES) {
		throw new Error('Zotero crop PNG is missing or too large');
	}
	const png = Buffer.from(row.pngBase64, 'base64');
	if (png.length > MAX_CROP_PNG_BYTES || png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		throw new Error('Zotero crop response is not a bounded PNG');
	}
	return png;
}

/** Materialize Zotero Reading Mode source crops beside the private PDF. */
async function ensureStructuredPdfSourceCrops(
	env: CoreEnv,
	input: Readonly<{
		crops: readonly StructuredPdfSourceCrop[];
		inputContentHash: string;
		pdfStorageKey: string;
		sourceLabel: string;
	}>,
): Promise<void> {
	const cropKey = (id: string) => structuredPdfCropKey(input.pdfStorageKey, input.inputContentHash, id);
	const plannedIds = new Set(input.crops.map(({ id }) => id));
	if (plannedIds.size !== input.crops.length) throw new Error('Structured PDF crop IDs must be unique');
	const readyCropIds = new Set<string>();
	const failed = new Map<string, ReturnType<typeof cropFailure>>();
	// HEAD only this recipe's keys: old parser revisions cannot exhaust a LIST page.
	for (let offset = 0; offset < input.crops.length; offset += CROP_BATCH_SIZE) {
		await Promise.all(
			input.crops.slice(offset, offset + CROP_BATCH_SIZE).map(async (crop) => {
				const object = await env.R2.head(cropKey(crop.id));
				if (object?.customMetadata?.artifactVersion === SOURCE_CROP_ARTIFACT_VERSION) readyCropIds.add(crop.id);
			}),
		);
	}
	const missing = input.crops.filter(({ id }) => !readyCropIds.has(id));
	for (let offset = 0; offset < missing.length; offset += CROP_BATCH_SIZE) {
		const batch = missing.slice(offset, offset + CROP_BATCH_SIZE);
		try {
			const pdf = await env.R2.get(input.pdfStorageKey);
			if (!pdf) throw new NonRetryableError('PDF source object is missing');
			const response = await coreExports.ZoteroSdt.getByName(ZOTERO_SDT_CONTAINER_NAME).request('render-areas', pdf.body, pdf.size, {
				'x-pdf-crops': JSON.stringify(batch.map(({ id, pageIndex, rect }) => ({ id, pageIndex, rect }))),
			});
			if (!response.ok) {
				const body = await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES, 'Zotero source crop error');
				throw statusError(response.status, [400, 413, 415, 422], `Zotero source crop failed with ${response.status}: ${body}`);
			}
			const expected = new Set(batch.map(({ id }) => id));
			for await (const value of cropResponseRows(response)) {
				if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !expected.delete(value.id)) {
					throw new Error('Zotero crop batch returned an unexpected or duplicate ID');
				}
				const row = value as Record<string, unknown>;
				const id = value.id;
				try {
					if (typeof row.error === 'string') {
						const ErrorType = row.retryable === false ? NonRetryableError : Error;
						throw new ErrorType(row.error.slice(0, MAX_ERROR_BODY_BYTES));
					}
					await putPdfDerivative(env, input.pdfStorageKey, cropKey(id), cropPng(row), {
						customMetadata: { artifactVersion: SOURCE_CROP_ARTIFACT_VERSION },
						httpMetadata: { contentType: 'image/png' },
					});
					readyCropIds.add(id);
				} catch (error) {
					failed.set(id, cropFailure(error));
				}
			}
			for (const id of expected) failed.set(id, { reason: 'Zotero crop batch ended before this crop was returned', retryable: true });
		} catch (error) {
			for (const { id } of batch) if (!readyCropIds.has(id)) failed.set(id, cropFailure(error));
		}
	}
	console.info({
		tag: 'PDF_PARSE',
		event: 'zotero_source_crops_completed',
		crop_count: input.crops.length,
		ready_count: readyCropIds.size,
		source: input.sourceLabel,
	});
	if (readyCropIds.size !== plannedIds.size) {
		// Stored PNGs are the retry checkpoints: Workflow retries reuse the parsed document and every finished crop.
		// A partial batch must never become a successful acquisition checkpoint.
		const retryable = [...failed.values()].some(({ retryable }) => retryable);
		const ErrorType = retryable ? Error : NonRetryableError;
		const [firstId, first] = [...failed][0] ?? [];
		throw new ErrorType(
			`Structured PDF crops incomplete: ${readyCropIds.size}/${plannedIds.size}${first ? `; ${firstId}: ${first.reason}` : ''}`,
		);
	}
}

async function parsePdfArtifactStream(input: ReadableStream<Uint8Array>, byteLength: number, sourceLabel: string) {
	try {
		const response = await coreExports.ZoteroSdt.getByName(ZOTERO_SDT_CONTAINER_NAME).request('parse', input, byteLength);
		const maxBytes = response.ok ? ZOTERO_SDT_MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES;
		const body = await readBoundedResponseText(response, maxBytes, 'Zotero SDT response');
		if (!response.ok) {
			const message = structuredPdfFailureMessage(response.status, body);
			// Only a documented invalid/unreadable PDF is a permanent parse outcome.
			// Busy, startup, transport and malformed responses remain retryable.
			throw statusError(response.status, [400, 422], message);
		}
		return parseStructuredPdfDocumentJson(body);
	} catch (error) {
		console.error({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_failed',
			parser_version: ZOTERO_SDT_ARTIFACT_VERSION,
			source: sourceLabel,
			error: errorMessage(error),
		});
		throw error;
	}
}

async function readStructuredPdfArtifact(
	env: CoreEnv,
	pdfStorageKey: string,
	inputContentHash: string,
): Promise<StructuredPdfDocument | null> {
	const object = await env.R2.get(structuredPdfDocumentKey(pdfStorageKey));
	if (!object) return null;
	if (object.customMetadata?.artifactVersion !== ZOTERO_SDT_ARTIFACT_VERSION || object.customMetadata?.inputSha256 !== inputContentHash) {
		await object.body.cancel('Structured PDF artifact revision is stale');
		return null;
	}
	if (object.size < 1 || object.size > ZOTERO_SDT_MAX_RESPONSE_BYTES) {
		await object.body.cancel('Structured PDF artifact size is invalid');
		return null;
	}
	const json = await object.text();
	try {
		return parseStructuredPdfDocumentJson(json);
	} catch (error) {
		console.warn({ tag: 'PDF_PARSE', event: 'zotero_sdt_artifact_invalid', error: errorMessage(error) });
		return null;
	}
}

/** A stored PDF to read, kept under `blobKey(inputContentHash)`: an owned upload has no URL, a fetched one keeps where it was fetched from. */
type PdfSource = Readonly<{ url: string | null; fileName: string | null; inputContentHash: string; sourceLabel: string }>;

/** One acquisition path for owned uploads and independently fetched public PDFs. */
async function parseStoredPdfRepresentation(env: CoreEnv, { inputContentHash, sourceLabel }: PdfSource) {
	const pdfStorageKey = blobKey(inputContentHash);
	let document = await readStructuredPdfArtifact(env, pdfStorageKey, inputContentHash);
	if (!document) {
		const object = await env.R2.get(pdfStorageKey);
		if (!object) throw new NonRetryableError('PDF source object is missing');
		if (object.size < 1 || object.size > MAX_PDF_BYTES) {
			await object.body.cancel('PDF source size is invalid');
			throw new NonRetryableError(`PDF source object must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		document = await parsePdfArtifactStream(object.body, object.size, sourceLabel);
		await putPdfDerivative(env, pdfStorageKey, structuredPdfDocumentKey(pdfStorageKey), JSON.stringify(document), {
			customMetadata: { artifactVersion: ZOTERO_SDT_ARTIFACT_VERSION, inputSha256: inputContentHash },
		});
	}
	const normalized = normalizeStructuredPdf(document, storedPdfCropUrlPrefix(inputContentHash));
	// The body becomes readable only after every planned crop is stored.
	await ensureStructuredPdfSourceCrops(env, { crops: normalized.crops, inputContentHash, pdfStorageKey, sourceLabel });
	console.info({ tag: 'PDF_PARSE', event: 'zotero_sdt_completed', source: sourceLabel, ...normalized.parse });
	return normalized;
}

/**
 * Zotero reads the body of every PDF. Its first page and its own properties are where it prints its DOI or arXiv id and
 * its title; without a printed title it is titled by its file name.
 */
export async function stagePdfDocument(env: CoreEnv, step: WorkflowStep, pdf: PdfSource): Promise<ReadDocument> {
	const body = await stepJson(step, `parse-pdf-body-v2-${pdf.url ? blobKey(pdf.inputContentHash) : 'stored'}`, PDF_PARSE_STEP, async () => {
		const { markdown, references, paperIdentifierText, title } = await parseStoredPdfRepresentation(env, pdf);
		return { markdown, references, paperIdentifierText, title };
	});
	if (!body.markdown) throw new NonRetryableError(`${pdf.sourceLabel} has no usable text; OCR is required`);
	const name = pdf.fileName?.trim() || 'PDF';
	return {
		url: pdf.url,
		title: body.title ?? (name.replace(/\.[a-z0-9]{1,8}$/i, '') || name),
		source: pdf.url ? new URL(pdf.url).hostname.replace(/^www\./, '') : 'File',
		printed: { ...paperIdentityFromText(body.paperIdentifierText), title: body.title },
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

function decodedPathSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		// Keep a malformed path segment in its encoded form.
		return segment;
	}
}

/** A fetched public PDF is stored by its bytes, like any upload. */
export async function storePublicPdfResponse(env: CoreEnv, response: Response, sourceUrl: string): Promise<PdfSource> {
	const source = new URL(sourceUrl);
	if (!response.body) throw new Error(`Public PDF response has no body (${response.status})`);
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
		await response.body.cancel('Public PDF is too large');
		throw new NonRetryableError(`PDF exceeded ${MAX_PDF_BYTES} bytes`);
	}
	// Checkpoint the bounded source before parsing; retries must not download it again.
	const bytes = await new Response(
		limitByteStream(response.body, MAX_PDF_BYTES, () => new NonRetryableError(`PDF exceeded ${MAX_PDF_BYTES} bytes`)),
	).arrayBuffer();
	if (!bytes.byteLength) throw new NonRetryableError('Fetched PDF response body is empty');
	// Reject HTML/error payloads before storing them as PDFs or starting the parser.
	if (!Buffer.from(bytes, 0, Math.min(bytes.byteLength, 1024)).includes('%PDF-')) {
		throw new NonRetryableError('Fetched PDF response has no PDF header');
	}
	const inputContentHash = hash('sha256', new Uint8Array(bytes), 'hex');
	await env.R2.put(blobKey(inputContentHash), bytes, { httpMetadata: { contentType: 'application/pdf' } });
	const fileName = source.pathname.split('/').filter(Boolean).at(-1) ?? null;
	return {
		url: source.toString(),
		fileName: fileName && decodedPathSegment(fileName),
		inputContentHash,
		sourceLabel: `Public PDF ${inputContentHash}`,
	};
}

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const READY_TIMEOUT_MS = 240_000;
const READY_POLL_MS = 500;
const PING_TIMEOUT_MS = 5_000;

/** Durable Object-scheduled Zotero document-worker. Each call streams one R2 PDF into the container. */
export class ZoteroSdt extends DurableObject<CoreEnv> {
	constructor(ctx: DurableObjectState, env: CoreEnv) {
		super(ctx, env);
		// Inactivity timeouts do not survive a Durable Object restart.
		const container = ctx.container;
		if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
	}

	/** `parse` answers with the structured document; `render-areas` streams one PNG row per crop in `x-pdf-crops`. */
	async request(operation: PdfOperation, input: ReadableStream<Uint8Array>, byteLength: number, headers: Record<string, string> = {}) {
		const port = await this.ensureReady(input, operation, byteLength);
		const startedAt = Date.now();
		const response = await port.fetch(`http://zotero-sdt/${operation}`, {
			body: input.pipeThrough(new FixedLengthStream(byteLength)),
			headers: { 'content-type': 'application/pdf', ...headers },
			method: 'POST',
		});
		// Time to response headers; the server answers only after the whole document is processed.
		console.info({
			tag: 'PDF_PARSE',
			event: 'zotero_sdt_request_completed',
			operation,
			status: response.status,
			duration_ms: Date.now() - startedAt,
			byte_length: byteLength,
		});
		return response;
	}

	private async ensureReady(input: ReadableStream<Uint8Array>, operation: PdfOperation, byteLength: number): Promise<Fetcher> {
		const startedAt = Date.now();
		const coldStart = !this.ctx.container?.running;
		try {
			const container = this.ctx.container;
			if (!container) throw new Error('ZoteroSdt has no attached container');
			if (coldStart) {
				// `basic` is not a runtime instance size; `lite` (256 MiB) cannot hold PDF.js and canvas.
				container.start({ enableInternet: false, image: container.images['zotero-sdt'], instance: 'standard-1' });
				this.ctx.waitUntil(
					container.monitor().then(
						() => console.info({ tag: 'PDF_PARSE', event: 'zotero_sdt_container_exited' }),
						(error: unknown) =>
							console.error({
								tag: 'PDF_PARSE',
								event: 'zotero_sdt_container_crashed',
								error: errorMessage(error),
								exit_code: (error as { exitCode?: number } | null)?.exitCode ?? null,
							}),
					),
				);
				await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
			}
			const port = container.getTcpPort(PORT);
			await waitForPort(container, port);
			console.info({
				tag: 'PDF_PARSE',
				event: 'zotero_sdt_container_ready',
				operation,
				cold_start: coldStart,
				ready_ms: Date.now() - startedAt,
				byte_length: byteLength,
			});
			return port;
		} catch (error) {
			console.error({
				tag: 'PDF_PARSE',
				event: 'zotero_sdt_container_not_ready',
				operation,
				cold_start: coldStart,
				waited_ms: Date.now() - startedAt,
				error: errorMessage(error),
			});
			await input.cancel('PDF container failed to become ready');
			throw error;
		}
	}
}

type PdfOperation = 'parse' | 'render-areas';

/** `start()` returns before the server listens; any HTTP response (the server 404s pings) means it is ready. */
async function waitForPort(container: Container, port: Fetcher): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		try {
			const response = await port.fetch('http://zotero-sdt/ping', { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
			await response.body?.cancel();
			return;
		} catch (error) {
			const reason = errorMessage(error);
			if (!container.running) throw new Error(`PDF container exited before it became ready: ${reason}`);
			if (Date.now() >= deadline) throw new Error(`PDF container did not become ready: ${reason}`);
			await scheduler.wait(READY_POLL_MS);
		}
	}
}
