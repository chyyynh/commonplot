import { assessPdfTexts, type PdfTextSanitationSummary, stripUnsafePdfText } from './pdf-text-quality.ts';

export const PARSED_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const LITEPARSE_POLICY_REVISION = 'liteparse-blocks-v2' as const;

export type ParsedDocumentBboxV1 = Readonly<{
	x: number;
	y: number;
	width: number;
	height: number;
}>;

export type ParsedDocumentCellV1 = Readonly<{
	text: string;
	bbox: ParsedDocumentBboxV1 | null;
}>;

export type ParsedDocumentBlockTypeV1 = 'heading' | 'paragraph' | 'list' | 'code' | 'table' | 'figure' | 'equation' | 'rule' | 'unknown';

export type ParsedDocumentBlockV1 = Readonly<{
	id: string;
	type: ParsedDocumentBlockTypeV1;
	sourceKind: string;
	bbox: ParsedDocumentBboxV1 | null;
	text: string | null;
	style: Readonly<{ bold: boolean; italic: boolean }>;
	heading: Readonly<{ level: number | null }> | null;
	list: Readonly<{ level: number | null; marker: string | null; ordered: boolean }> | null;
	code: Readonly<{ language: string | null; lines: string[] }> | null;
	table: Readonly<{
		header: ParsedDocumentCellV1[];
		rows: ParsedDocumentCellV1[][];
		fallbackLines: string[];
	}> | null;
	figure: Readonly<{ id: string | null; format: string | null }> | null;
}>;

export type ParsedPageQualityV1 = Readonly<{
	needsOcr: boolean;
	isGarbled: boolean;
	reasons: string[];
	textLength: number;
	textCoverage: number;
	pageArea: number;
	images: Readonly<{
		hasSubstantialImages: boolean;
		blockCount: number;
		coverage: number;
		largestCoverage: number;
		fullPage: boolean;
	}>;
	uncoveredVectorArea: number | null;
	layout: Readonly<{
		columnCount: number;
		ruledTableCount: number;
		ruledTableCoverage: number;
		textTableRunCount: number;
		figureCount: number;
		figureCoverage: number;
		isComplex: boolean;
		reasons: string[];
	}> | null;
	sanitation: PdfTextSanitationSummary;
}>;

export type ParsedDocumentPageV1 = Readonly<{
	pageNumber: number;
	width: number;
	height: number;
	source: 'liteparse' | 'llamaparse';
	text: string;
	markdown: string;
	usable: boolean;
	quality: ParsedPageQualityV1;
	blocks: ParsedDocumentBlockV1[];
}>;

export type ParsedDocumentV1 = Readonly<{
	schemaVersion: typeof PARSED_DOCUMENT_SCHEMA_VERSION;
	parser: Readonly<{
		name: 'liteparse';
		version: string;
		policyRevision: typeof LITEPARSE_POLICY_REVISION;
	}>;
	coordinateSystem: Readonly<{
		origin: 'top-left';
		unit: 'pdf-point';
		pointsPerInch: 72;
	}>;
	totalPages: number;
	parsedPages: number;
	pages: ParsedDocumentPageV1[];
	pageErrors: ReadonlyArray<Readonly<{ pageNumber: number; message: string }>>;
	quality: Readonly<{
		complete: boolean;
		usablePages: number;
		needsOcrPages: number[];
		garbledPages: number[];
		complexLayoutPages: number[];
		failedPages: number[];
		unparsedPages: number;
		problemPages: number[];
	}>;
	markdown: string;
}>;

type LiteParseResultRecord = Readonly<{
	totalPages: number;
	pages: ParsedDocumentPageV1[];
	pageErrors: Array<{ pageNumber: number; message: string }>;
}>;

const BLOCK_TYPES: Readonly<Record<string, ParsedDocumentBlockTypeV1>> = {
	heading: 'heading',
	paragraph: 'paragraph',
	list_item: 'list',
	code: 'code',
	table: 'table',
	grid_fallback: 'table',
	figure: 'figure',
	equation: 'equation',
	rule: 'rule',
};

function invalidLiteParseResponse(path: string, expectation: string): never {
	throw new Error(`Invalid LiteParse response: ${path} must be ${expectation}`);
}

function responseRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return invalidLiteParseResponse(path, 'an object');
	}
	return value as Record<string, unknown>;
}

function responseString(value: unknown, path: string): string {
	if (typeof value !== 'string') return invalidLiteParseResponse(path, 'a string');
	return value;
}

function responseBoolean(value: unknown, path: string): boolean {
	if (typeof value !== 'boolean') return invalidLiteParseResponse(path, 'a boolean');
	return value;
}

function responseFiniteNumber(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return invalidLiteParseResponse(path, 'a finite number');
	}
	return Object.is(value, -0) ? 0 : value;
}

function responseInteger(value: unknown, path: string, minimum: number): number {
	const number = responseFiniteNumber(value, path);
	if (!Number.isInteger(number) || number < minimum) {
		return invalidLiteParseResponse(path, `an integer greater than or equal to ${minimum}`);
	}
	return number;
}

function responseRatio(value: unknown, path: string): number {
	const number = responseFiniteNumber(value, path);
	if (number < 0 || number > 1) return invalidLiteParseResponse(path, 'between 0 and 1');
	return number;
}

function optionalString(value: unknown, path: string): string | null {
	return value === undefined ? null : stripUnsafePdfText(responseString(value, path));
}

function optionalInteger(value: unknown, path: string): number | null {
	return value === undefined ? null : responseInteger(value, path, 0);
}

function optionalBoolean(value: unknown, path: string): boolean {
	return value === undefined ? false : responseBoolean(value, path);
}

function responseStrings(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) return invalidLiteParseResponse(path, 'an array');
	return value.map((item, index) => stripUnsafePdfText(responseString(item, `${path}[${index}]`)));
}

function canonicalReasonCodes(value: unknown, path: string): string[] {
	return [
		...new Set(
			responseStrings(value, path)
				.map((reason) => reason.trim())
				.filter(Boolean),
		),
	].sort();
}

function optionalBbox(value: unknown, path: string): ParsedDocumentBboxV1 | null {
	if (value === undefined) return null;
	const bbox = responseRecord(value, path);
	const width = responseFiniteNumber(bbox.width, `${path}.width`);
	const height = responseFiniteNumber(bbox.height, `${path}.height`);
	if (width < 0 || height < 0) return invalidLiteParseResponse(path, 'a non-negative rectangle');
	return {
		x: responseFiniteNumber(bbox.x, `${path}.x`),
		y: responseFiniteNumber(bbox.y, `${path}.y`),
		width,
		height,
	};
}

function canonicalCell(value: unknown, path: string): ParsedDocumentCellV1 {
	const cell = responseRecord(value, path);
	return {
		text: stripUnsafePdfText(responseString(cell.text, `${path}.text`)).trim(),
		bbox: optionalBbox(cell.bbox, `${path}.bbox`),
	};
}

function canonicalCells(value: unknown, path: string): ParsedDocumentCellV1[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return invalidLiteParseResponse(path, 'an array');
	return value.map((cell, index) => canonicalCell(cell, `${path}[${index}]`));
}

function canonicalCellRows(value: unknown, path: string): ParsedDocumentCellV1[][] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return invalidLiteParseResponse(path, 'an array');
	return value.map((row, index) => canonicalCells(row, `${path}[${index}]`));
}

function canonicalBlockText(
	text: string | null,
	sourceKind: string,
	lines: readonly string[],
	header: readonly ParsedDocumentCellV1[],
	rows: readonly ParsedDocumentCellV1[][],
): string | null {
	const directText = text ? stripUnsafePdfText(text).trim() || null : null;
	if (directText) return directText;
	if (sourceKind === 'code' || sourceKind === 'grid_fallback') {
		return lines.join('\n').trim() || null;
	}
	if (sourceKind === 'table') {
		return (
			[header, ...rows]
				.map((cells) =>
					cells
						.map((cell) => cell.text)
						.filter(Boolean)
						.join('\t'),
				)
				.filter(Boolean)
				.join('\n') || null
		);
	}
	return null;
}

function canonicalBlock(value: unknown, pageNumber: number, index: number): ParsedDocumentBlockV1 {
	const path = `pages[${pageNumber - 1}].blocks[${index}]`;
	const block = responseRecord(value, path);
	const sourceKind = responseString(block.kind, `${path}.kind`).trim();
	if (!sourceKind) return invalidLiteParseResponse(`${path}.kind`, 'a non-empty string');
	const lines = sourceKind === 'code' || sourceKind === 'grid_fallback' ? responseStrings(block.lines ?? [], `${path}.lines`) : [];
	const header = sourceKind === 'table' ? canonicalCells(block.header, `${path}.header`) : [];
	const rows = sourceKind === 'table' ? canonicalCellRows(block.rows, `${path}.rows`) : [];
	return {
		id: `p${pageNumber}-b${index + 1}`,
		type: BLOCK_TYPES[sourceKind] ?? 'unknown',
		sourceKind,
		bbox: optionalBbox(block.bbox, `${path}.bbox`),
		text: canonicalBlockText(optionalString(block.text, `${path}.text`), sourceKind, lines, header, rows),
		style: {
			bold: optionalBoolean(block.bold, `${path}.bold`),
			italic: optionalBoolean(block.italic, `${path}.italic`),
		},
		heading: sourceKind === 'heading' ? { level: optionalInteger(block.level, `${path}.level`) } : null,
		list:
			sourceKind === 'list_item'
				? {
						level: optionalInteger(block.level, `${path}.level`),
						marker: optionalString(block.marker, `${path}.marker`),
						ordered: optionalBoolean(block.ordered, `${path}.ordered`),
					}
				: null,
		code:
			sourceKind === 'code'
				? {
						language: optionalString(block.lang, `${path}.lang`),
						lines,
					}
				: null,
		table:
			sourceKind === 'table' || sourceKind === 'grid_fallback'
				? {
						header,
						rows,
						fallbackLines: sourceKind === 'grid_fallback' ? lines : [],
					}
				: null,
		figure:
			sourceKind === 'figure'
				? {
						id: optionalString(block.id, `${path}.id`),
						format: optionalString(block.format, `${path}.format`),
					}
				: null,
	};
}

function canonicalLayout(value: unknown, path: string): ParsedPageQualityV1['layout'] {
	if (value === undefined) return null;
	const layout = responseRecord(value, path);
	return {
		columnCount: responseInteger(layout.columnCount, `${path}.columnCount`, 0),
		ruledTableCount: responseInteger(layout.ruledTableCount, `${path}.ruledTableCount`, 0),
		ruledTableCoverage: responseRatio(layout.ruledTableCoverage, `${path}.ruledTableCoverage`),
		textTableRunCount: responseInteger(layout.textTableRunCount, `${path}.textTableRunCount`, 0),
		figureCount: responseInteger(layout.figureCount, `${path}.figureCount`, 0),
		figureCoverage: responseRatio(layout.figureCoverage, `${path}.figureCoverage`),
		isComplex: responseBoolean(layout.isComplex, `${path}.isComplex`),
		reasons: canonicalReasonCodes(layout.reasons, `${path}.reasons`),
	};
}

function canonicalQuality(value: unknown, pageNumber: number, path: string, sanitation: PdfTextSanitationSummary): ParsedPageQualityV1 {
	const quality = responseRecord(value, path);
	if (responseInteger(quality.pageNumber, `${path}.pageNumber`, 1) !== pageNumber) {
		return invalidLiteParseResponse(`${path}.pageNumber`, `equal to page ${pageNumber}`);
	}
	const uncoveredVectorArea =
		quality.uncoveredVectorArea === undefined ? null : responseFiniteNumber(quality.uncoveredVectorArea, `${path}.uncoveredVectorArea`);
	if (uncoveredVectorArea !== null && uncoveredVectorArea < 0) {
		return invalidLiteParseResponse(`${path}.uncoveredVectorArea`, 'non-negative');
	}
	const pageArea = responseFiniteNumber(quality.pageArea, `${path}.pageArea`);
	if (pageArea <= 0) return invalidLiteParseResponse(`${path}.pageArea`, 'positive');
	const providerNeedsOcr = responseBoolean(quality.needsOcr, `${path}.needsOcr`);
	const providerIsGarbled = responseBoolean(quality.isGarbled, `${path}.isGarbled`);
	return {
		needsOcr: providerNeedsOcr || sanitation.isGarbled,
		isGarbled: providerIsGarbled || sanitation.isGarbled,
		reasons: [
			...new Set([...canonicalReasonCodes(quality.reasons, `${path}.reasons`), ...(sanitation.isGarbled ? ['binary-garbage'] : [])]),
		].sort(),
		textLength: responseInteger(quality.textLength, `${path}.textLength`, 0),
		textCoverage: responseRatio(quality.textCoverage, `${path}.textCoverage`),
		pageArea,
		images: {
			hasSubstantialImages: responseBoolean(quality.hasSubstantialImages, `${path}.hasSubstantialImages`),
			blockCount: responseInteger(quality.imageBlockCount, `${path}.imageBlockCount`, 0),
			coverage: responseRatio(quality.imageCoverage, `${path}.imageCoverage`),
			largestCoverage: responseRatio(quality.largestImageCoverage, `${path}.largestImageCoverage`),
			fullPage: responseBoolean(quality.fullPageImage, `${path}.fullPageImage`),
		},
		uncoveredVectorArea,
		layout: canonicalLayout(quality.layout, `${path}.layout`),
		sanitation,
	};
}

function extractedTextChars(markdown: string): number {
	const content = markdown.replace(/^```[^\n]*$/gm, '').replace(/^[-_*]{3,}$/gm, '');
	return content.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function canonicalPage(value: unknown, index: number, totalPages: number): ParsedDocumentPageV1 {
	const path = `pages[${index}]`;
	const page = responseRecord(value, path);
	const pageNumber = responseInteger(page.pageNum, `${path}.pageNum`, 1);
	if (pageNumber > totalPages) return invalidLiteParseResponse(`${path}.pageNum`, `within the ${totalPages}-page document`);
	const width = responseFiniteNumber(page.width, `${path}.width`);
	const height = responseFiniteNumber(page.height, `${path}.height`);
	if (width <= 0 || height <= 0) return invalidLiteParseResponse(path, 'a page with positive dimensions');
	const rawText = responseString(page.text, `${path}.text`);
	const rawMarkdown = responseString(page.markdown, `${path}.markdown`);
	const sanitation = assessPdfTexts([rawText, rawMarkdown]);
	const text = stripUnsafePdfText(rawText).trim();
	const markdown = stripUnsafePdfText(rawMarkdown).trim();
	const quality = canonicalQuality(page.complexity, pageNumber, `${path}.complexity`, sanitation);
	if (!Array.isArray(page.blocks)) return invalidLiteParseResponse(`${path}.blocks`, 'an array');
	return {
		pageNumber,
		width,
		height,
		source: 'liteparse',
		text,
		markdown,
		usable: !quality.isGarbled && extractedTextChars(markdown) > 0,
		quality,
		blocks: page.blocks.map((block, blockIndex) => canonicalBlock(block, pageNumber, blockIndex)),
	};
}

function canonicalPageErrors(value: unknown, totalPages: number): Array<{ pageNumber: number; message: string }> {
	if (!Array.isArray(value)) return invalidLiteParseResponse('pageErrors', 'an array');
	return value
		.map((item, index) => {
			const path = `pageErrors[${index}]`;
			const error = responseRecord(item, path);
			const pageNumber = responseInteger(error.pageNum, `${path}.pageNum`, 1);
			if (pageNumber > totalPages) return invalidLiteParseResponse(`${path}.pageNum`, `within the ${totalPages}-page document`);
			const message = stripUnsafePdfText(responseString(error.message, `${path}.message`)).trim();
			if (!message) return invalidLiteParseResponse(`${path}.message`, 'a non-empty string');
			return { pageNumber, message };
		})
		.sort(
			(left, right) => left.pageNumber - right.pageNumber || (left.message < right.message ? -1 : left.message > right.message ? 1 : 0),
		);
}

function canonicalLiteParseResult(value: unknown): LiteParseResultRecord {
	const result = responseRecord(value, 'result');
	const totalPages = responseInteger(result.totalPages, 'result.totalPages', 1);
	if (!Array.isArray(result.pages) || result.pages.length === 0) {
		return invalidLiteParseResponse('result.pages', 'a non-empty array');
	}
	const pages = result.pages.map((page, index) => canonicalPage(page, index, totalPages));
	if (pages.some((page, index) => index > 0 && page.pageNumber <= (pages[index - 1]?.pageNumber ?? 0))) {
		return invalidLiteParseResponse('result.pages', 'in strictly increasing source-page order');
	}
	return {
		totalPages,
		pages,
		pageErrors: canonicalPageErrors(result.pageErrors, totalPages),
	};
}

function sortedPageUnion(...lists: readonly number[][]): number[] {
	return [...new Set(lists.flat())].sort((left, right) => left - right);
}

function assertParserVersion(parserVersion: string): void {
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(parserVersion)) {
		throw new TypeError('LiteParse parser version is not a safe artifact revision');
	}
}

export function assembleLiteParseDocument(result: LiteParseResultRecord, parserVersion: string): ParsedDocumentV1 {
	assertParserVersion(parserVersion);
	if (!Number.isInteger(result.totalPages) || result.totalPages < 1) {
		throw new TypeError('LiteParse artifact totalPages must be a positive integer');
	}
	if (
		result.pages.length === 0 ||
		result.pages.some(
			(page, index) => page.pageNumber > result.totalPages || (index > 0 && page.pageNumber <= (result.pages[index - 1]?.pageNumber ?? 0)),
		)
	) {
		throw new TypeError('LiteParse artifact pages must be in strictly increasing source-page order');
	}
	const usablePages = result.pages.filter((page) => page.usable);
	const needsOcrPages = result.pages.filter((page) => page.quality.needsOcr).map((page) => page.pageNumber);
	const garbledPages = result.pages.filter((page) => page.quality.isGarbled).map((page) => page.pageNumber);
	const complexLayoutPages = result.pages.filter((page) => page.quality.layout?.isComplex).map((page) => page.pageNumber);
	const failedPages = sortedPageUnion(result.pageErrors.map((error) => error.pageNumber));
	const coveredPages = new Set([...result.pages.map((page) => page.pageNumber), ...failedPages]);
	const unparsedPages = Math.max(0, result.totalPages - coveredPages.size);
	return {
		schemaVersion: PARSED_DOCUMENT_SCHEMA_VERSION,
		parser: { name: 'liteparse', version: parserVersion, policyRevision: LITEPARSE_POLICY_REVISION },
		coordinateSystem: { origin: 'top-left', unit: 'pdf-point', pointsPerInch: 72 },
		totalPages: result.totalPages,
		parsedPages: result.pages.length,
		pages: result.pages,
		pageErrors: result.pageErrors,
		quality: {
			complete: failedPages.length === 0 && unparsedPages === 0,
			usablePages: usablePages.length,
			needsOcrPages,
			garbledPages,
			complexLayoutPages,
			failedPages,
			unparsedPages,
			problemPages: sortedPageUnion(needsOcrPages, garbledPages, complexLayoutPages, failedPages),
		},
		markdown: usablePages
			.map((page) => page.markdown)
			.join('\n\n')
			.trim(),
	};
}

export function normalizeLiteParseDocument(value: unknown, parserVersion: string): ParsedDocumentV1 {
	return assembleLiteParseDocument(canonicalLiteParseResult(value), parserVersion);
}

export function serializeParsedDocument(document: ParsedDocumentV1): string {
	return JSON.stringify(document);
}
