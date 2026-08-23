import { initSync, LiteParse, type LiteParseInit } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import liteParsePackage from '@llamaindex/liteparse-wasm/package.json';
import {
	assemblePdfWorkingDocument,
	normalizeLiteParseWorkingDocument,
	type PdfWorkingDocumentV1,
	type PdfWorkingPageV1,
} from './pdf-working-document';

const LITEPARSE_CONFIG = {
	continueOnPageError: true,
	extractBlocks: false,
	imageMode: 'off',
	includeComplexity: true,
	ocrEnabled: false,
	outputFormat: 'markdown',
	quiet: true,
} satisfies LiteParseInit;

const liteParseRuntime = initSync({ module: wasmModule });

export function liteParseLinearMemoryBytes(): number {
	return liteParseRuntime.memory.buffer.byteLength;
}

export async function parsePdfWithLiteParse(bytes: Uint8Array): Promise<PdfWorkingDocumentV1> {
	const parser = new LiteParse(LITEPARSE_CONFIG);
	try {
		const result: unknown = await parser.parse(bytes);
		return normalizeLiteParseWorkingDocument(result, liteParsePackage.version);
	} finally {
		parser.free();
	}
}

export async function parsePdfWithLiteParseBatches(bytes: Uint8Array, batchSize: number): Promise<PdfWorkingDocumentV1> {
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
		throw new TypeError('LiteParse batch size must be an integer between 1 and 100');
	}
	const parser = new LiteParse(LITEPARSE_CONFIG);
	let session: Awaited<ReturnType<LiteParse['openBatchSession']>> | undefined;
	try {
		session = await parser.openBatchSession(bytes, batchSize);
		const pages: PdfWorkingPageV1[] = [];
		const pageErrors: Array<{ pageNumber: number; message: string }> = [];
		for (;;) {
			const batch = await session.nextBatch();
			if (!batch) break;
			const document = normalizeLiteParseWorkingDocument(batch.result, liteParsePackage.version);
			pages.push(...document.pages);
			pageErrors.push(...document.pageErrors);
		}
		return assemblePdfWorkingDocument({ totalPages: session.totalPages, pages, pageErrors }, liteParsePackage.version);
	} finally {
		try {
			session?.free();
		} finally {
			parser.free();
		}
	}
}
