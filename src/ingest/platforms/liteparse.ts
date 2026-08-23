import { initSync, LiteParse, type LiteParseInit } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import liteParsePackage from '@llamaindex/liteparse-wasm/package.json';
import { normalizeLiteParseDocument, type ParsedDocumentV1 } from './parsed-document';

const LITEPARSE_CONFIG = {
	continueOnPageError: true,
	extractBlocks: true,
	imageMode: 'off',
	includeComplexity: true,
	ocrEnabled: false,
	outputFormat: 'markdown',
	quiet: true,
} satisfies LiteParseInit;

initSync({ module: wasmModule });

export async function parsePdfWithLiteParse(bytes: Uint8Array): Promise<ParsedDocumentV1> {
	const parser = new LiteParse(LITEPARSE_CONFIG);
	try {
		const result: unknown = await parser.parse(bytes);
		return normalizeLiteParseDocument(result, liteParsePackage.version);
	} finally {
		parser.free();
	}
}
