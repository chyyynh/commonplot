import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import liteParsePackage from '@llamaindex/liteparse-wasm/package.json' with { type: 'json' };
import {
	assemblePdfWorkingDocument,
	normalizeLiteParseWorkingDocument,
	serializePdfWorkingDocument,
} from '../src/ingest/platforms/pdf-working-document.ts';

const inputPath = process.argv[2];
const mode = process.argv[3] ?? 'whole';
const batchSize = Number(process.argv[4] ?? 10);
if (!inputPath) throw new Error('Usage: pnpm probe:pdf-artifact /absolute/path/to/document.pdf [whole|batch|compare] [batchSize]');
if (mode !== 'whole' && mode !== 'batch' && mode !== 'compare') throw new Error('Probe mode must be whole, batch, or compare');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Batch size must be between 1 and 100');

const wasmUrl = import.meta.resolve('@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm');
initSync({ module: await readFile(fileURLToPath(wasmUrl)) });

const inputUrl = pathToFileURL(inputPath);
const bytes = new Uint8Array(await readFile(inputUrl));
function newParser() {
	return new LiteParse({
		continueOnPageError: true,
		extractBlocks: false,
		imageMode: 'off',
		includeComplexity: true,
		ocrEnabled: false,
		outputFormat: 'markdown',
		quiet: true,
	});
}

async function parseDocument(parseMode) {
	const parser = newParser();
	try {
		if (parseMode === 'whole') return normalizeLiteParseWorkingDocument(await parser.parse(bytes), liteParsePackage.version);
		const session = await parser.openBatchSession(bytes, batchSize);
		try {
			const pages = [];
			const pageErrors = [];
			for (;;) {
				const batch = await session.nextBatch();
				if (!batch) break;
				const normalized = normalizeLiteParseWorkingDocument(batch.result, liteParsePackage.version);
				pages.push(...normalized.pages);
				pageErrors.push(...normalized.pageErrors);
			}
			return assemblePdfWorkingDocument({ totalPages: session.totalPages, pages, pageErrors }, liteParsePackage.version);
		} finally {
			session.free();
		}
	} finally {
		parser.free();
	}
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function documentSummary(document, parseMode, durationMs) {
	const workingDocument = serializePdfWorkingDocument(document);
	return {
		mode: parseMode,
		...(parseMode === 'batch' ? { batchSize } : {}),
		workingDocumentBytes: new TextEncoder().encode(workingDocument).byteLength,
		workingDocumentSha256: sha256(workingDocument),
		markdownSha256: sha256(document.markdown),
		durationMs,
		totalPages: document.totalPages,
		parsedPages: document.parsedPages,
		usablePages: document.quality.usablePages,
		problemPages: document.quality.problemPages,
		failedPages: document.quality.failedPages,
		unparsedPages: document.quality.unparsedPages,
	};
}

async function timedParse(parseMode) {
	const startedAt = performance.now();
	const document = await parseDocument(parseMode);
	return { document, summary: documentSummary(document, parseMode, Math.round(performance.now() - startedAt)) };
}

if (mode === 'compare') {
	const whole = await timedParse('whole');
	const batch = await timedParse('batch');
	const differingPages = whole.document.pages.flatMap((wholePage, index) => {
		const batchPage = batch.document.pages[index];
		if (!batchPage || sha256(JSON.stringify(wholePage)) !== sha256(JSON.stringify(batchPage))) {
			return [
				{
					pageNumber: wholePage.pageNumber,
					textEqual: wholePage.text === batchPage?.text,
					markdownEqual: wholePage.markdown === batchPage?.markdown,
					qualityEqual: JSON.stringify(wholePage.quality) === JSON.stringify(batchPage?.quality),
				},
			];
		}
		return [];
	});
	console.info(
		JSON.stringify(
			{
				event: 'pdf_working_document_modes_compared',
				file: basename(inputPath),
				inputBytes: bytes.byteLength,
				whole: whole.summary,
				batch: batch.summary,
				differingPages,
			},
			null,
			2,
		),
	);
} else {
	const result = await timedParse(mode);
	console.info(
		JSON.stringify(
			{
				event: 'pdf_working_document_probe_completed',
				file: basename(inputPath),
				inputBytes: bytes.byteLength,
				...result.summary,
			},
			null,
			2,
		),
	);
}
