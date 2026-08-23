import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import liteParsePackage from '@llamaindex/liteparse-wasm/package.json' with { type: 'json' };
import { normalizeLiteParseDocument, serializeParsedDocument } from '../src/ingest/platforms/parsed-document.ts';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: pnpm probe:pdf-artifact /absolute/path/to/document.pdf');

const wasmUrl = import.meta.resolve('@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm');
initSync({ module: await readFile(fileURLToPath(wasmUrl)) });

const inputUrl = pathToFileURL(inputPath);
const bytes = new Uint8Array(await readFile(inputUrl));
const parser = new LiteParse({
	continueOnPageError: true,
	extractBlocks: true,
	imageMode: 'off',
	includeComplexity: true,
	ocrEnabled: false,
	outputFormat: 'markdown',
	quiet: true,
});

try {
	const startedAt = performance.now();
	const result = await parser.parse(bytes);
	const document = normalizeLiteParseDocument(result, liteParsePackage.version);
	const artifactBytes = new TextEncoder().encode(serializeParsedDocument(document)).byteLength;
	console.info({
		event: 'pdf_artifact_probe_completed',
		file: basename(inputPath),
		inputBytes: bytes.byteLength,
		artifactBytes,
		durationMs: Math.round(performance.now() - startedAt),
		totalPages: document.totalPages,
		parsedPages: document.parsedPages,
		blocks: document.pages.reduce((count, page) => count + page.blocks.length, 0),
		usablePages: document.quality.usablePages,
		problemPages: document.quality.problemPages,
		failedPages: document.quality.failedPages,
		unparsedPages: document.quality.unparsedPages,
	});
} finally {
	parser.free();
}
