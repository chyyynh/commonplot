const { hash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve, sep } = require('node:path');
const { Worker } = require('node:worker_threads');
const { inflateRawSync } = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const MAX_PDF_BYTES = Number.parseInt(process.env.MAX_PDF_BYTES ?? String(25 * 1024 * 1024), 10);
const MAX_DOCUMENT_BYTES = Number.parseInt(process.env.MAX_DOCUMENT_BYTES ?? String(32 * 1024 * 1024), 10);
const MAX_CROP_BYTES = Number.parseInt(process.env.MAX_CROP_BYTES ?? String(8 * 1024 * 1024), 10);
const WORKER_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.WORKER_REQUEST_TIMEOUT_MS ?? String(5 * 60 * 1000), 10);
const MAX_PENDING_REQUESTS = 4;
const MAX_CROPS_PER_BATCH = 8;
const WORKER_QUEUE_TIMEOUT_MS = 30_000;
const BUILD_DIR = resolve(process.env.DOCUMENT_WORKER_BUILD_DIR ?? '/app/document-worker');

if (!Number.isInteger(WORKER_REQUEST_TIMEOUT_MS) || WORKER_REQUEST_TIMEOUT_MS < 1_000 || WORKER_REQUEST_TIMEOUT_MS > 15 * 60 * 1000) {
	throw new Error('WORKER_REQUEST_TIMEOUT_MS must be an integer between 1000 and 900000.');
}

if (!Number.isSafeInteger(MAX_CROP_BYTES) || MAX_CROP_BYTES < 1 || MAX_CROP_BYTES > 8 * 1024 * 1024) {
	throw new Error('MAX_CROP_BYTES must be an integer between 1 and 8388608.');
}

class DocumentWorkerClient {
	constructor(options = {}) {
		this.nextRequestId = 0;
		this.activeRequest = null;
		this.pending = [];
		this.running = false;
		this.maxPendingRequests = options.maxPendingRequests ?? MAX_PENDING_REQUESTS;
		this.queueTimeoutMs = options.queueTimeoutMs ?? WORKER_QUEUE_TIMEOUT_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? WORKER_REQUEST_TIMEOUT_MS;
		this.onFatal = options.onFatal ?? (() => setImmediate(() => process.exit(1)));
		this.failure = null;
		this.worker = options.worker ?? new Worker(resolve(__dirname, 'worker-thread.cjs'), { workerData: { buildDir: BUILD_DIR } });
		this.ready = Promise.withResolvers();
		this.worker.on('message', (message) => this.handleMessage(message));
		this.worker.on('error', (error) => this.crash(error));
		this.worker.on('exit', (code) => {
			this.crash(new Error(`Zotero document worker exited unexpectedly with code ${code}.`));
		});
	}

	handleMessage(message) {
		if (message?.ready) {
			this.ready.resolve();
			return;
		}
		if (message?.action === 'FetchData' && message.id) {
			this.sendAsset(message.id, message.data);
			return;
		}
		if (!message?.responseID) return;
		const request = this.activeRequest;
		if (!request || request.id !== message.responseID) return;
		this.activeRequest = null;
		if (message.error) request.reject(toError(message.error));
		else request.resolve(message.data);
	}

	sendAsset(responseID, assetPath) {
		try {
			const absolutePath = resolve(BUILD_DIR, assetPath);
			if (absolutePath !== BUILD_DIR && !absolutePath.startsWith(`${BUILD_DIR}${sep}`)) {
				throw new Error(`Refusing to read an asset outside the document-worker build: ${assetPath}`);
			}
			const buffer = readFileSync(absolutePath);
			const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
			this.worker.postMessage({ responseID, data }, [data]);
		} catch (error) {
			try {
				this.worker.postMessage({ responseID, error: error instanceof Error ? error : new Error(String(error)) });
			} catch (postError) {
				this.crash(postError);
			}
		}
	}

	crash(error) {
		if (this.failure) return;
		const failure = error instanceof Error ? error : new Error(String(error));
		this.failure = failure;
		this.ready.reject(failure);
		this.activeRequest?.reject(failure);
		this.activeRequest = null;
		console.error({ error: failure.message, event: 'zotero_sdt_document_worker_failed' });
		for (const pending of this.pending.splice(0)) {
			clearTimeout(pending.timeout);
			pending.reject(failure);
		}
		this.onFatal(failure);
	}

	request(action, pdfBuffer, data) {
		if (this.failure) return Promise.reject(this.failure);
		if (this.running && this.pending.length >= this.maxPendingRequests) return Promise.reject(busyError('PDF worker queue is full.'));
		const result = Promise.withResolvers();
		const entry = { action, pdfBuffer, data, ...result, timeout: null };
		if (this.running) {
			entry.timeout = setTimeout(() => {
				const index = this.pending.indexOf(entry);
				if (index < 0) return;
				this.pending.splice(index, 1);
				entry.reject(busyError('PDF worker queue wait timed out.'));
			}, this.queueTimeoutMs);
			this.pending.push(entry);
		} else void this.run(entry);
		return result.promise;
	}

	async run(entry) {
		this.running = true;
		clearTimeout(entry.timeout);
		const timeout = setTimeout(
			() => this.crash(busyError(`Zotero document worker request ${entry.action} timed out after ${this.requestTimeoutMs}ms.`)),
			this.requestTimeoutMs,
		);
		try {
			if (this.failure) throw this.failure;
			const id = ++this.nextRequestId;
			const buffer = entry.pdfBuffer.buffer.slice(entry.pdfBuffer.byteOffset, entry.pdfBuffer.byteOffset + entry.pdfBuffer.byteLength);
			const request = Promise.withResolvers();
			this.activeRequest = { id, ...request };
			try {
				this.worker.postMessage({ action: entry.action, data: { buf: buffer, password: '', ...entry.data }, id }, [buffer]);
			} catch (error) {
				this.crash(error);
			}
			entry.resolve(await request.promise);
		} catch (error) {
			entry.reject(error);
		} finally {
			clearTimeout(timeout);
			this.running = false;
			const next = this.pending.shift();
			if (next) void this.run(next);
		}
	}
}

function busyError(message) {
	return Object.assign(new Error(message), { statusCode: 503 });
}

function toError(value) {
	return value instanceof Error ? value : Object.assign(new Error(value?.message ?? 'Zotero document worker failed.'), value);
}

async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_PDF_BYTES) throw Object.assign(new Error(`PDF exceeds the ${MAX_PDF_BYTES}-byte limit.`), { statusCode: 413 });
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

function sendJson(response, status, body) {
	response
		.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(status === 503 ? { 'retry-after': '10' } : {}) })
		.end(JSON.stringify(body));
}

function createDocumentServer(client, openStructuredDocumentTextPack) {
	let activeRequests = 0;
	return createServer(async (request, response) => {
		if (activeRequests >= MAX_PENDING_REQUESTS + 1) return sendJson(response, 503, { error: 'PDF service is busy.' });
		activeRequests++;
		try {
			const url = new URL(request.url ?? '/', 'http://container');
			if (request.method !== 'POST' || !['/parse', '/render-areas'].includes(url.pathname)) {
				return sendJson(response, 404, { error: 'Not found.' });
			}
			if (!request.headers['content-type']?.toLowerCase().startsWith('application/pdf')) {
				return sendJson(response, 415, { error: 'Content-Type must be application/pdf.' });
			}
			let crops;
			if (url.pathname === '/render-areas') {
				try {
					crops = JSON.parse(request.headers['x-pdf-crops'] ?? 'null');
				} catch {
					return sendJson(response, 400, { error: 'Invalid crop batch.' });
				}
				if (!validCropBatch(crops)) return sendJson(response, 400, { error: 'Invalid crop batch.' });
			}
			const pdfBuffer = await readBody(request);
			if (!pdfBuffer.length) return sendJson(response, 400, { error: 'PDF body is empty.' });
			if (url.pathname === '/render-areas') {
				response.writeHead(200, { 'content-type': 'application/x-ndjson' });
				for (const crop of crops) {
					if (response.destroyed) return;
					let row;
					try {
						const png = await renderCrop(client, pdfBuffer, crop);
						row = { id: crop.id, pngBase64: png.toString('base64') };
					} catch (error) {
						row = {
							id: crop.id,
							error: (error instanceof Error ? error.message : 'PDF render failed.').slice(0, 1000),
							retryable: !isPermanentPdfError(error),
						};
					}
					await writeRow(response, row);
				}
				return response.end();
			}
			try {
				const result = await client.request('getStructuredDocumentText', pdfBuffer, {
					contentType: 'application/pdf',
					sourceHash: hash('md5', pdfBuffer),
				});
				const reader = await openStructuredDocumentTextPack(result.buf, {
					inflate: (bytes) => inflateRawSync(bytes, { maxOutputLength: MAX_DOCUMENT_BYTES }),
				});
				const document = await reader.materialize();
				const json = JSON.stringify(document);
				if (Buffer.byteLength(json) > MAX_DOCUMENT_BYTES)
					throw new Error(`Structured document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit.`);
				return response.writeHead(200, { 'content-type': 'application/vnd.newsence.structured-document+json' }).end(json);
			} catch (parseError) {
				if (parseError?.statusCode === 503 || client.failure) throw parseError;
				let totalPages = null;
				try {
					const inspection = await client.request('pdf.getFulltext', pdfBuffer, { maxPages: 1 });
					if (Number.isInteger(inspection?.totalPages) && inspection.totalPages > 0) totalPages = inspection.totalPages;
				} catch (inspectionError) {
					console.warn({
						error: inspectionError instanceof Error ? inspectionError.message : String(inspectionError),
						event: 'zotero_sdt_page_count_failed',
					});
				}
				console.error({ error: parseError instanceof Error ? parseError.message : String(parseError), event: 'zotero_sdt_parse_failed' });
				return sendJson(response, 422, {
					error: parseError instanceof Error ? parseError.message : 'Parse failed.',
					totalPages,
				});
			}
		} catch (error) {
			console.error({ error: error instanceof Error ? error.message : String(error), event: 'zotero_sdt_request_failed' });
			if (response.headersSent) {
				if (!response.writableEnded) response.destroy(error instanceof Error ? error : undefined);
				return;
			}
			return sendJson(response, error?.statusCode ?? (isPermanentPdfError(error) ? 422 : 500), {
				error: error instanceof Error ? error.message : 'Parse failed.',
			});
		} finally {
			activeRequests--;
		}
	});
}

function validCropBatch(crops) {
	return (
		Array.isArray(crops) &&
		crops.length > 0 &&
		crops.length <= MAX_CROPS_PER_BATCH &&
		new Set(crops.map((crop) => crop?.id)).size === crops.length &&
		crops.every(
			(crop) =>
				crop &&
				typeof crop.id === 'string' &&
				/^[a-zA-Z0-9_.-]{1,160}$/.test(crop.id) &&
				Number.isInteger(crop.pageIndex) &&
				crop.pageIndex >= 0 &&
				Array.isArray(crop.rect) &&
				crop.rect.length === 4 &&
				crop.rect.every(Number.isFinite) &&
				crop.rect[2] > crop.rect[0] &&
				crop.rect[3] > crop.rect[1],
		)
	);
}

async function renderCrop(client, pdfBuffer, crop) {
	const width = crop.rect[2] - crop.rect[0];
	const height = crop.rect[3] - crop.rect[1];
	// Bound the canvas before allocation; a PNG byte limit alone cannot bound
	// decompressed memory for an unusually large PDF page or source rectangle.
	const scale = Math.min(3, 8192 / width, 8192 / height, Math.sqrt((16 * 1024 * 1024) / width / height));
	if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(scale) || scale <= 0) {
		throw Object.assign(new Error('PDF crop dimensions are not renderable.'), { statusCode: 422 });
	}
	const result = await client.request('pdf.renderArea', pdfBuffer, { pageIndex: crop.pageIndex, rect: crop.rect, scale });
	const png = result?.buf ? Buffer.from(result.buf) : null;
	if (!png?.length || png.length > MAX_CROP_BYTES || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
		throw Object.assign(new Error('Rendered PDF area is not a valid bounded PNG.'), { statusCode: 422 });
	return png;
}

function isPermanentPdfError(error) {
	return (
		[400, 413, 415, 422].includes(error?.statusCode) ||
		['InvalidPDFException', 'MissingPDFException', 'PasswordException'].includes(error?.name)
	);
}

async function writeRow(response, row) {
	if (response.destroyed || response.write(`${JSON.stringify(row)}\n`)) return;
	await new Promise((resolve, reject) => {
		const cleanup = () => {
			response.off('drain', onDone);
			response.off('close', onDone);
			response.off('error', onError);
		};
		const onDone = () => {
			cleanup();
			resolve();
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		response.once('drain', onDone);
		response.once('close', onDone);
		response.once('error', onError);
		if (response.destroyed) onDone();
	});
}

module.exports = { DocumentWorkerClient, createDocumentServer };

if (require.main === module) {
	const { openStructuredDocumentTextPack } = require(resolve(BUILD_DIR, 'structured-document-text.js'));
	const client = new DocumentWorkerClient();
	const server = createDocumentServer(client, openStructuredDocumentTextPack);
	client.ready.promise.then(
		() => server.listen(PORT, '0.0.0.0'),
		() => undefined,
	);
}
