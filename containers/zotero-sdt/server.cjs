const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve, sep } = require('node:path');
const { Worker } = require('node:worker_threads');
const { inflateRawSync } = require('node:zlib');

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const MAX_PDF_BYTES = Number.parseInt(process.env.MAX_PDF_BYTES ?? String(25 * 1024 * 1024), 10);
const MAX_DOCUMENT_BYTES = Number.parseInt(process.env.MAX_DOCUMENT_BYTES ?? String(32 * 1024 * 1024), 10);
const BUILD_DIR = resolve(process.env.DOCUMENT_WORKER_BUILD_DIR ?? '/app/document-worker');
const WORKER_PATH = resolve(__dirname, 'worker-thread.cjs');

if (!existsSync(resolve(BUILD_DIR, 'worker.js')) || !existsSync(resolve(BUILD_DIR, 'structured-document-text.js'))) {
	throw new Error(`Missing document-worker build at ${BUILD_DIR}.`);
}

const { openStructuredDocumentTextPack } = require(resolve(BUILD_DIR, 'structured-document-text.js'));

class DocumentWorkerClient {
	constructor() {
		this.nextRequestId = 0;
		this.pending = new Map();
		this.queue = Promise.resolve();
		this.worker = new Worker(WORKER_PATH, { workerData: { buildDir: BUILD_DIR } });
		this.ready = new Promise((resolveReady, rejectReady) => {
			this.resolveReady = resolveReady;
			this.rejectReady = rejectReady;
		});
		this.worker.on('message', (message) => this.handleMessage(message));
		this.worker.on('error', (error) => this.fail(error));
		this.worker.on('exit', (code) => {
			if (code !== 0) this.fail(new Error(`Zotero document worker exited with code ${code}.`));
		});
	}

	handleMessage(message) {
		if (message?.ready) {
			this.resolveReady();
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
			this.worker.postMessage({ responseID, error: serializeError(error) });
		}
	}

	fail(error) {
		this.rejectReady(error);
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	request(action, pdfBuffer, data) {
		const job = this.queue.then(async () => {
			await this.ready;
			const id = ++this.nextRequestId;
			const buffer = pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength);
			return await new Promise((resolveRequest, rejectRequest) => {
				this.pending.set(id, { reject: rejectRequest, resolve: resolveRequest });
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
			});
		});
		this.queue = job.catch(() => undefined);
		return job;
	}

	parse(pdfBuffer, sourceHash) {
		return this.request('getStructuredDocumentText', pdfBuffer, {
			contentType: 'application/pdf',
			reportProgress: false,
			sourceHash,
		});
	}

	inspect(pdfBuffer) {
		return this.request('pdf.getFulltext', pdfBuffer, { maxPages: 1 });
	}
}

function toError(value) {
	const error = new Error(value?.message ?? 'Zotero document worker failed.');
	error.name = value?.name ?? 'Error';
	if (value?.stack) error.stack = value.stack;
	return error;
}

function serializeError(error) {
	if (error instanceof Error) return { message: error.message, name: error.name, stack: error.stack };
	return { message: String(error), name: 'Error' };
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
		if (request.method === 'GET' && url.pathname === '/health') {
			await client.ready;
			return sendJson(response, 200, { ok: true });
		}
		if (request.method !== 'POST' || url.pathname !== '/parse') return sendJson(response, 404, { error: 'Not found.' });
		if (!request.headers['content-type']?.toLowerCase().startsWith('application/pdf')) {
			return sendJson(response, 415, { error: 'Content-Type must be application/pdf.' });
		}
		const declaredLength = Number.parseInt(request.headers['content-length'] ?? '0', 10);
		if (declaredLength > MAX_PDF_BYTES) return sendJson(response, 413, { error: `PDF exceeds the ${MAX_PDF_BYTES}-byte limit.` });

		const pdfBuffer = await readBody(request);
		if (!pdfBuffer.length) return sendJson(response, 400, { error: 'PDF body is empty.' });
		const sourceHash = createHash('md5').update(pdfBuffer).digest('hex');
		const startedAt = performance.now();
		try {
			const result = await client.parse(pdfBuffer, sourceHash);
			const parsedAt = performance.now();
			const reader = await openStructuredDocumentTextPack(result.buf, {
				inflate: (bytes) => new Uint8Array(inflateRawSync(bytes)),
			});
			const document = await reader.materialize();
			const json = JSON.stringify(document);
			const documentBytes = Buffer.byteLength(json);
			if (documentBytes > MAX_DOCUMENT_BYTES) {
				const error = new Error(`Structured document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit.`);
				error.statusCode = 413;
				throw error;
			}
			const rssMiB = Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
			response.writeHead(200, {
				'cache-control': 'no-store',
				'content-length': String(documentBytes),
				'content-type': 'application/vnd.newsence.structured-document+json',
				'x-newsence-materialize-ms': String(Math.round((performance.now() - parsedAt) * 100) / 100),
				'x-newsence-parse-ms': String(Math.round((parsedAt - startedAt) * 100) / 100),
				'x-newsence-rss-mib': String(rssMiB),
				'x-newsence-source-hash': sourceHash,
			});
			return response.end(json);
		} catch (parseError) {
			let totalPages = null;
			try {
				const inspection = await client.inspect(pdfBuffer);
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
		return sendJson(response, error?.statusCode ?? 500, { error: error instanceof Error ? error.message : 'Parse failed.' });
	}
});

server.listen(PORT, '0.0.0.0', () => {
	console.info({
		buildDir: BUILD_DIR,
		event: 'zotero_sdt_container_listening',
		maxDocumentBytes: MAX_DOCUMENT_BYTES,
		maxPdfBytes: MAX_PDF_BYTES,
		port: PORT,
	});
});
