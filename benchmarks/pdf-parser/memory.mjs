import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import WebSocket from 'ws';

const inspectorHttpUrl = process.argv[2];
const baseUrl = process.argv[3];
const inputPath = process.argv[4];
const concurrency = Number(process.argv[5] ?? 1);
const mode = process.argv[6] ?? 'whole';
const batchSize = Number(process.argv[7] ?? 10);

if (!inspectorHttpUrl || !baseUrl || !inputPath) {
	throw new Error('Usage: node memory.mjs INSPECTOR_HTTP_URL BASE_URL PDF_PATH [concurrency] [whole|batch] [batchSize]');
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('Concurrency must be 1 or 2');
if (mode !== 'whole' && mode !== 'batch') throw new Error('Mode must be whole or batch');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Batch size must be between 1 and 100');

const targets = await fetch(new URL('/json', inspectorHttpUrl)).then((response) => response.json());
const webSocketUrl = targets[0]?.webSocketDebuggerUrl;
if (typeof webSocketUrl !== 'string') throw new Error('Wrangler inspector did not expose a WebSocket target');

const socket = new WebSocket(webSocketUrl, { origin: new URL(inspectorHttpUrl).origin });
await new Promise((resolve, reject) => {
	socket.addEventListener('open', resolve, { once: true });
	socket.addEventListener('error', () => reject(new Error('Could not connect to the Wrangler inspector')), { once: true });
});

let commandId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
	const message = JSON.parse(String(event.data));
	if (!message.id) return;
	const pendingCommand = pending.get(message.id);
	if (!pendingCommand) return;
	pending.delete(message.id);
	clearTimeout(pendingCommand.timeout);
	if (message.error) pendingCommand.reject(new Error(message.error.message));
	else pendingCommand.resolve(message.result);
});

function inspectorCommand(method, params) {
	const id = ++commandId;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Wrangler inspector did not answer ${method} within 5 seconds`));
		}, 5_000);
		pending.set(id, { resolve, reject, timeout });
		socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
	});
}

await inspectorCommand('Runtime.enable');
await inspectorCommand('HeapProfiler.enable');

const samples = [];
let samplePending;
async function sample() {
	if (samplePending) return samplePending;
	samplePending = inspectorCommand('Runtime.getHeapUsage').then((usage) => {
		samples.push({ atMs: Math.round(performance.now()), ...usage });
	});
	try {
		await samplePending;
	} finally {
		samplePending = undefined;
	}
}

await sample();
const baseline = samples[0];
let samplingError;
const sampling = setInterval(() => {
	void sample().catch((error) => {
		samplingError ??= error;
	});
}, 10);

const bytes = new Uint8Array(await readFile(inputPath));
const benchmarkUrl = new URL('/benchmark', baseUrl);
benchmarkUrl.searchParams.set('mode', mode);
if (mode === 'batch') benchmarkUrl.searchParams.set('batchSize', String(batchSize));

async function invoke(index) {
	const startedAt = performance.now();
	const response = await fetch(benchmarkUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.byteLength) },
		body: bytes,
	});
	const body = await response.json();
	if (!response.ok) throw new Error(`Invocation ${index} failed (${response.status}): ${JSON.stringify(body)}`);
	return { index, clientWallMs: Math.round(performance.now() - startedAt), ...body };
}

const startedAt = performance.now();
let results;
try {
	results = await Promise.all(Array.from({ length: concurrency }, (_, index) => invoke(index + 1)));
	await sample();
	if (samplingError) throw samplingError;
} finally {
	clearInterval(sampling);
	socket.terminate();
}

function maximum(field) {
	return Math.max(...samples.map((entry) => entry[field] ?? 0));
}

console.info(
	JSON.stringify(
		{
			event: 'pdf_worker_memory_sample_completed',
			file: basename(inputPath),
			mode,
			...(mode === 'batch' ? { batchSize } : {}),
			concurrency,
			groupWallMs: Math.round(performance.now() - startedAt),
			sampleCount: samples.length,
			baseline,
			peak: {
				usedSize: maximum('usedSize'),
				totalSize: maximum('totalSize'),
				embedderHeapUsedSize: maximum('embedderHeapUsedSize'),
				backingStorageSize: maximum('backingStorageSize'),
			},
			results,
		},
		null,
		2,
	),
);
