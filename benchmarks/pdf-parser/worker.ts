import { liteParseLinearMemoryBytes, parsePdfWithLiteParse, parsePdfWithLiteParseBatches } from '../../src/ingest/platforms/liteparse';
import { serializePdfWorkingDocument } from '../../src/ingest/platforms/pdf-working-document';
import { sha256Hex } from '../../src/shared/hash';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PDF_MIME = 'application/pdf';

function jsonError(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

function parsePositiveInteger(value: string | null, fallback: number, maximum: number): number {
	if (value === null) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new TypeError(`Expected an integer between 1 and ${maximum}`);
	return parsed;
}

function isPdf(bytes: Uint8Array): boolean {
	return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

async function runBenchmark(request: Request): Promise<Response> {
	if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== PDF_MIME) {
		return jsonError('Content-Type must be application/pdf', 415);
	}
	const declaredLength = Number(request.headers.get('content-length'));
	if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) return jsonError('A positive Content-Length is required', 411);
	if (declaredLength > MAX_PDF_BYTES) return jsonError(`PDF exceeds ${MAX_PDF_BYTES} bytes`, 413);

	const url = new URL(request.url);
	const mode = url.searchParams.get('mode') ?? 'whole';
	if (mode !== 'whole' && mode !== 'batch') return jsonError('mode must be whole or batch', 400);
	let batchSize: number;
	try {
		batchSize = parsePositiveInteger(url.searchParams.get('batchSize'), 10, 100);
	} catch (error) {
		return jsonError(error instanceof Error ? error.message : 'Invalid batch size', 400);
	}

	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength !== declaredLength) return jsonError('Request body length does not match Content-Length', 400);
	if (!isPdf(bytes)) return jsonError('Request body does not begin with a PDF signature', 400);

	const wasmMemoryBeforeBytes = liteParseLinearMemoryBytes();
	const document = mode === 'whole' ? await parsePdfWithLiteParse(bytes) : await parsePdfWithLiteParseBatches(bytes, batchSize);
	const wasmMemoryAfterBytes = liteParseLinearMemoryBytes();
	const workingDocument = serializePdfWorkingDocument(document);
	const [workingDocumentSha256, markdownSha256] = await Promise.all([sha256Hex(workingDocument), sha256Hex(document.markdown)]);
	return Response.json({
		mode,
		...(mode === 'batch' ? { batchSize } : {}),
		inputBytes: bytes.byteLength,
		wasmMemoryBeforeBytes,
		wasmMemoryAfterBytes,
		workingDocumentBytes: new TextEncoder().encode(workingDocument).byteLength,
		workingDocumentSha256,
		markdownSha256,
		totalPages: document.totalPages,
		parsedPages: document.parsedPages,
		usablePages: document.quality.usablePages,
		problemPages: document.quality.problemPages,
		failedPages: document.quality.failedPages,
		unparsedPages: document.quality.unparsedPages,
	});
}

export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
		if (request.method !== 'POST' || url.pathname !== '/benchmark') return jsonError('Not found', 404);
		try {
			return await runBenchmark(request);
		} catch (error) {
			console.error({
				tag: 'PDF_BENCHMARK',
				event: 'parse_failed',
				error: error instanceof Error ? error.message : String(error),
			});
			return jsonError(error instanceof Error ? error.message : 'PDF benchmark failed', 422);
		}
	},
} satisfies ExportedHandler;
