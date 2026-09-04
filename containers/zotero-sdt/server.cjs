const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
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
const BUILD_DIR = resolve(process.env.DOCUMENT_WORKER_BUILD_DIR ?? '/app/document-worker');

if (!Number.isInteger(WORKER_REQUEST_TIMEOUT_MS) || WORKER_REQUEST_TIMEOUT_MS < 1_000 || WORKER_REQUEST_TIMEOUT_MS > 15 * 60 * 1000) {
	throw new Error('WORKER_REQUEST_TIMEOUT_MS must be an integer between 1000 and 900000.');
}

if (!existsSync(resolve(BUILD_DIR, 'worker.js')) || !existsSync(resolve(BUILD_DIR, 'structured-document-text.js'))) {
	throw new Error(`Missing document-worker build at ${BUILD_DIR}.`);
}

const { openStructuredDocumentTextPack } = require(resolve(BUILD_DIR, 'structured-document-text.js'));

class DocumentWorkerClient {
	constructor() {
		this.nextRequestId = 0;
		this.pending = new Map();
		this.queue = Promise.resolve();
		this.failure = null;
		this.worker = new Worker(resolve(__dirname, 'worker-thread.cjs'), { workerData: { buildDir: BUILD_DIR } });
		this.ready = Promise.withResolvers();
		this.worker.on('message', (message) => this.handleMessage(message));
		this.worker.on('error', (error) => this.crash(error));
		this.worker.on('exit', (code) => {
			this.crash(new Error(`Zotero document worker exited unexpectedly with code ${code}.`));
		});
	}

	handleMessage(message) {
		if (message?.ready) {
			if (this.failure) return;
			this.ready.resolve();
			return;
		}
		if (message?.action === 'FetchData' && message.id) {
			this.sendAsset(message.id, message.data);
			return;
		}
		if (!message?.responseID) return;
		const pending = this.pending.get(message.responseID);
		if (!pending) return;
		this.pending.delete(message.responseID);
		if (message.error) pending.reject(toError(message.error));
		else pending.resolve(message.data);
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
		for (const pending of this.pending.values()) pending.reject(failure);
		this.pending.clear();
		console.error({ error: failure.message, event: 'zotero_sdt_document_worker_failed' });
		setImmediate(() => process.exit(1));
	}

	request(action, pdfBuffer, data) {
		if (this.failure) return Promise.reject(this.failure);
		const timeoutError = new Error(`Zotero document worker request ${action} timed out after ${WORKER_REQUEST_TIMEOUT_MS}ms.`);
		timeoutError.statusCode = 504;
		let timeout;
		const queuedJob = this.queue.then(async () => {
			if (this.failure) throw this.failure;
			const id = ++this.nextRequestId;
			const buffer = pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength);
			const pending = Promise.withResolvers();
			this.pending.set(id, pending);
			try {
				this.worker.postMessage(
					{
						action,
						data: {
							buf: buffer,
							password: '',
							...data,
						},
						id,
					},
					[buffer],
				);
			} catch (error) {
				this.pending.delete(id);
				pending.reject(error);
				this.crash(error);
			}
			return pending.promise;
		});
		const timeoutJob = new Promise((_resolveTimeout, rejectTimeout) => {
			timeout = setTimeout(() => {
				rejectTimeout(timeoutError);
				this.crash(timeoutError);
			}, WORKER_REQUEST_TIMEOUT_MS);
		});
		const job = Promise.race([queuedJob, timeoutJob]).finally(() => clearTimeout(timeout));
		this.queue = job.catch(() => undefined);
		return job;
	}
}

function toError(value) {
	return value instanceof Error ? value : Object.assign(new Error(value?.message ?? 'Zotero document worker failed.'), value);
}

async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_PDF_BYTES) {
			const error = new Error(`PDF exceeds the ${MAX_PDF_BYTES}-byte limit.`);
			error.statusCode = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
	const json = `${JSON.stringify(body)}\n`;
	response.writeHead(status, {
		'content-length': String(Buffer.byteLength(json)),
		'content-type': 'application/json; charset=utf-8',
	});
	response.end(json);
}

const client = new DocumentWorkerClient();
const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? '/', 'http://container');
		if (request.method !== 'POST' || (url.pathname !== '/parse' && url.pathname !== '/render-area')) {
			return sendJson(response, 404, { error: 'Not found.' });
		}
		if (!request.headers['content-type']?.toLowerCase().startsWith('application/pdf')) {
			return sendJson(response, 415, { error: 'Content-Type must be application/pdf.' });
		}
		const pdfBuffer = await readBody(request);
		if (!pdfBuffer.length) return sendJson(response, 400, { error: 'PDF body is empty.' });
		if (url.pathname === '/render-area') {
			const pageIndex = Number(url.searchParams.get('pageIndex'));
			const rect = (url.searchParams.get('rect') ?? '').split(',').map(Number);
			if (
				!Number.isInteger(pageIndex) ||
				pageIndex < 0 ||
				rect.length !== 4 ||
				rect.some((part) => !Number.isFinite(part)) ||
				!(rect[2] > rect[0]) ||
				!(rect[3] > rect[1])
			) {
				return sendJson(response, 400, { error: 'Invalid PDF render area.' });
			}
			try {
				const result = await client.request('pdf.renderArea', pdfBuffer, { pageIndex, rect, scale: 3 });
				if (!result?.buf) return sendJson(response, 422, { error: 'PDF render area is empty.' });
				const png = Buffer.from(result.buf);
				if (!png.length || png.length > MAX_CROP_BYTES || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
					return sendJson(response, 422, { error: 'Rendered PDF area is not a valid bounded PNG.' });
				}
				response.writeHead(200, {
					'content-length': String(png.length),
					'content-type': 'image/png',
				});
				return response.end(png);
			} catch (renderError) {
				console.error({
					error: renderError instanceof Error ? renderError.message : String(renderError),
					event: 'zotero_sdt_render_area_failed',
				});
				return sendJson(response, 422, { error: renderError instanceof Error ? renderError.message : 'PDF render area failed.' });
			}
		}
		const sourceHash = createHash('md5').update(pdfBuffer).digest('hex');
		try {
			const result = await client.request('getStructuredDocumentText', pdfBuffer, {
				contentType: 'application/pdf',
				sourceHash,
			});
			const reader = await openStructuredDocumentTextPack(result.buf, {
				inflate: (bytes) => inflateRawSync(bytes, { maxOutputLength: MAX_DOCUMENT_BYTES }),
			});
			const document = await reader.materialize();
			const json = JSON.stringify(document);
			const documentBytes = Buffer.byteLength(json);
			if (documentBytes > MAX_DOCUMENT_BYTES) {
				const error = new Error(`Structured document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit.`);
				error.statusCode = 413;
				throw error;
			}
			response.writeHead(200, {
				'content-length': String(documentBytes),
				'content-type': 'application/vnd.newsence.structured-document+json',
			});
			return response.end(json);
		} catch (parseError) {
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
		console.error({ error: error instanceof Error ? error.message : String(error), event: 'zotero_sdt_parse_failed' });
		if (response.headersSent) {
			if (!response.writableEnded) response.destroy(error instanceof Error ? error : undefined);
			return;
		}
		return sendJson(response, error?.statusCode ?? 500, { error: error instanceof Error ? error.message : 'Parse failed.' });
	}
});

client.ready.promise.then(
	() => server.listen(PORT, '0.0.0.0'),
	() => undefined,
);
