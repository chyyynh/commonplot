import {
	initSync,
	LiteParse,
	type LiteParseInit,
	type PageComplexityStats,
	type ParsedPage,
	type ParseResult,
} from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';

type LiteParsePageQuality = Pick<PageComplexityStats, 'isGarbled' | 'needsOcr' | 'pageNumber' | 'reasons'>;

export type PageAwareLiteParsePage = Pick<ParsedPage, 'height' | 'markdown' | 'pageNum' | 'text' | 'width'> & {
	complexity: LiteParsePageQuality;
};

export type PageAwareLiteParseResult = Pick<ParseResult, 'text' | 'totalPages'> & {
	pages: PageAwareLiteParsePage[];
};

const LITEPARSE_CONFIG = {
	continueOnPageError: true,
	imageMode: 'off',
	includeComplexity: true,
	ocrEnabled: false,
	outputFormat: 'markdown',
	quiet: true,
} satisfies LiteParseInit;

initSync({ module: wasmModule });

function invalidLiteParseResponse(path: string, expectation: string): never {
	throw new Error(`Invalid LiteParse response: ${path} must be ${expectation}`);
}

function responseRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return invalidLiteParseResponse(path, 'an object');
	}
	return value as Record<string, unknown>;
}

function responseBoolean(value: unknown, path: string): boolean {
	if (typeof value !== 'boolean') return invalidLiteParseResponse(path, 'a boolean');
	return value;
}

function responseString(value: unknown, path: string): string {
	if (typeof value !== 'string') return invalidLiteParseResponse(path, 'a string');
	return value;
}

function responsePositiveNumber(value: unknown, path: string, integer = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
		return invalidLiteParseResponse(path, integer ? 'a positive integer' : 'a positive finite number');
	}
	return value;
}

function validatePageQuality(value: unknown, pageNumber: number, path: string): void {
	const quality = responseRecord(value, path);
	const qualityPageNumber = responsePositiveNumber(quality.pageNumber, `${path}.pageNumber`, true);
	if (qualityPageNumber !== pageNumber) invalidLiteParseResponse(`${path}.pageNumber`, `equal to page ${pageNumber}`);
	responseBoolean(quality.isGarbled, `${path}.isGarbled`);
	responseBoolean(quality.needsOcr, `${path}.needsOcr`);
	if (!Array.isArray(quality.reasons) || quality.reasons.some((reason) => typeof reason !== 'string')) {
		invalidLiteParseResponse(`${path}.reasons`, 'an array of strings');
	}
}

function validatePage(value: unknown, index: number, totalPages: number): number {
	const path = `pages[${index}]`;
	const page = responseRecord(value, path);
	const pageNumber = responsePositiveNumber(page.pageNum, `${path}.pageNum`, true);
	if (pageNumber > totalPages) invalidLiteParseResponse(`${path}.pageNum`, `within the ${totalPages}-page document`);
	responsePositiveNumber(page.width, `${path}.width`);
	responsePositiveNumber(page.height, `${path}.height`);
	responseString(page.text, `${path}.text`);
	responseString(page.markdown, `${path}.markdown`);
	validatePageQuality(page.complexity, pageNumber, `${path}.complexity`);
	return pageNumber;
}

function assertPageAwareLiteParseResult(value: unknown): asserts value is PageAwareLiteParseResult {
	const result = responseRecord(value, 'result');
	const totalPages = responsePositiveNumber(result.totalPages, 'result.totalPages', true);
	responseString(result.text, 'result.text');
	if (!Array.isArray(result.pages) || result.pages.length === 0) {
		invalidLiteParseResponse('result.pages', 'a non-empty array');
	}
	const pageNumbers = result.pages.map((page, index) => validatePage(page, index, totalPages));
	if (pageNumbers.some((pageNumber, index) => index > 0 && pageNumber <= pageNumbers[index - 1])) {
		invalidLiteParseResponse('result.pages', 'in strictly increasing source-page order');
	}
}

export async function parsePdfWithLiteParse(bytes: Uint8Array): Promise<PageAwareLiteParseResult> {
	const parser = new LiteParse(LITEPARSE_CONFIG);
	try {
		const result: unknown = await parser.parse(bytes);
		assertPageAwareLiteParseResult(result);
		return result;
	} finally {
		parser.free();
	}
}
