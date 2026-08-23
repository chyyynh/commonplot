import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const baseUrl = process.argv[2];
const inputPath = process.argv[3];
const concurrency = Number(process.argv[4] ?? 1);
const mode = process.argv[5] ?? 'whole';
const batchSize = Number(process.argv[6] ?? 10);

if (!baseUrl || !inputPath) {
	throw new Error('Usage: node run.mjs BASE_URL PDF_PATH [concurrency] [whole|batch] [batchSize]');
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('Concurrency must be 1 or 2');
if (mode !== 'whole' && mode !== 'batch') throw new Error('Mode must be whole or batch');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Batch size must be between 1 and 100');

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
const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => invoke(index + 1)));
console.info(
	JSON.stringify(
		{
			event: 'pdf_worker_benchmark_completed',
			file: basename(inputPath),
			mode,
			...(mode === 'batch' ? { batchSize } : {}),
			concurrency,
			groupWallMs: Math.round(performance.now() - startedAt),
			results,
		},
		null,
		2,
	),
);
