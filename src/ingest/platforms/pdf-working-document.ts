import { PDF_PARSE_CONTRACT } from '../../shared/pdf-parse-contract.ts';
import { assessPdfTexts, type PdfTextSanitationSummary, stripUnsafePdfText } from './pdf-text-quality.ts';

export const PDF_WORKING_DOCUMENT_SCHEMA_VERSION = PDF_PARSE_CONTRACT.workingSchemaVersion;
export const LITEPARSE_POLICY_REVISION = PDF_PARSE_CONTRACT.litePolicyRevision;
export const PDF_TRANSLATION_CHUNK_MAX_LENGTH = 32_000;

export type PdfPageQualityV1 = Readonly<{
	needsOcr: boolean;
	isGarbled: boolean;
	reasons: string[];
	textLength: number;
	textCoverage: number;
	pageArea: number | null;
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

export type PdfWorkingPageV1 = Readonly<{
	pageNumber: number;
	width: number | null;
	height: number | null;
	source: 'liteparse' | 'llamaparse';
	text: string;
	markdown: string;
	usable: boolean;
	quality: PdfPageQualityV1;
}>;

export type PdfWorkingEnhancementV1 = Readonly<{
	provider: 'llamaparse';
	apiVersion: 'v2';
	version: string;
	policyRevision: string;
	requestedPages: number[];
	appliedPages: number[];
	failedPages: ReadonlyArray<Readonly<{ pageNumber: number; message: string }>>;
	usageCredits: number | null;
}>;

/**
 * Processing-only page state. Cloudflare Workflow streamed step output keeps it
 * durable between steps, but it is never the product's stored document. The
 * published projection is `markdown` in the original ResourceTranslation;
 * localized ResourceTranslation rows are derived separately.
 */
export type PdfWorkingDocumentV1 = Readonly<{
	schemaVersion: typeof PDF_WORKING_DOCUMENT_SCHEMA_VERSION;
	parser: Readonly<{
		name: 'liteparse';
		version: string;
		policyRevision: typeof LITEPARSE_POLICY_REVISION;
	}>;
	totalPages: number;
	parsedPages: number;
	pages: PdfWorkingPageV1[];
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
	enhancement?: PdfWorkingEnhancementV1;
}>;

type LiteParseWorkingResult = Readonly<{
	totalPages: number;
	pages: PdfWorkingPageV1[];
	pageErrors: Array<{ pageNumber: number; message: string }>;
}>;

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

function canonicalLayout(value: unknown, path: string): PdfPageQualityV1['layout'] {
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

function canonicalQuality(value: unknown, pageNumber: number, path: string, sanitation: PdfTextSanitationSummary): PdfPageQualityV1 {
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

function canonicalPage(value: unknown, index: number, totalPages: number): PdfWorkingPageV1 {
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
	return {
		pageNumber,
		width,
		height,
		source: 'liteparse',
		text,
		markdown,
		usable: !quality.isGarbled && extractedTextChars(markdown) > 0,
		quality,
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

function canonicalLiteParseResult(value: unknown): LiteParseWorkingResult {
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
		throw new TypeError('LiteParse parser version is not a safe working revision');
	}
}

export function assemblePdfWorkingDocument(result: LiteParseWorkingResult, parserVersion: string): PdfWorkingDocumentV1 {
	assertParserVersion(parserVersion);
	if (!Number.isInteger(result.totalPages) || result.totalPages < 1) {
		throw new TypeError('LiteParse working document totalPages must be a positive integer');
	}
	if (
		result.pages.length === 0 ||
		result.pages.some(
			(page, index) => page.pageNumber > result.totalPages || (index > 0 && page.pageNumber <= (result.pages[index - 1]?.pageNumber ?? 0)),
		)
	) {
		throw new TypeError('LiteParse working-document pages must be in strictly increasing source-page order');
	}
	const usablePages = result.pages.filter((page) => page.usable);
	const needsOcrPages = result.pages.filter((page) => page.quality.needsOcr).map((page) => page.pageNumber);
	const garbledPages = result.pages.filter((page) => page.quality.isGarbled).map((page) => page.pageNumber);
	const complexLayoutPages = result.pages.filter((page) => page.quality.layout?.isComplex).map((page) => page.pageNumber);
	const failedPages = sortedPageUnion(result.pageErrors.map((error) => error.pageNumber));
	const coveredPages = new Set([...result.pages.map((page) => page.pageNumber), ...failedPages]);
	const unparsedPageNumbers: number[] = [];
	for (let pageNumber = 1; pageNumber <= result.totalPages; pageNumber += 1) {
		if (!coveredPages.has(pageNumber)) unparsedPageNumbers.push(pageNumber);
	}
	return {
		schemaVersion: PDF_WORKING_DOCUMENT_SCHEMA_VERSION,
		parser: {
			name: 'liteparse',
			version: parserVersion,
			policyRevision: LITEPARSE_POLICY_REVISION,
		},
		totalPages: result.totalPages,
		parsedPages: result.pages.length,
		pages: result.pages,
		pageErrors: result.pageErrors,
		quality: {
			complete: failedPages.length === 0 && unparsedPageNumbers.length === 0,
			usablePages: usablePages.length,
			needsOcrPages,
			garbledPages,
			complexLayoutPages,
			failedPages,
			unparsedPages: unparsedPageNumbers.length,
			problemPages: sortedPageUnion(needsOcrPages, garbledPages, complexLayoutPages, failedPages, unparsedPageNumbers),
		},
		markdown: usablePages
			.map((page) => page.markdown)
			.join('\n\n')
			.trim(),
	};
}

export function normalizeLiteParseWorkingDocument(value: unknown, parserVersion: string): PdfWorkingDocumentV1 {
	return assemblePdfWorkingDocument(canonicalLiteParseResult(value), parserVersion);
}

export function serializePdfWorkingDocument(document: PdfWorkingDocumentV1): string {
	return JSON.stringify(document);
}

/**
 * Deterministically bounds private-PDF Markdown for durable translation steps.
 * Prefer a late Markdown/text boundary so ordinary paragraphs stay together;
 * the hard limit is only used for an unusually long unbroken block.
 */
export function splitPdfMarkdownForTranslation(markdown: string, maxLength = PDF_TRANSLATION_CHUNK_MAX_LENGTH): string[] {
	if (!Number.isInteger(maxLength) || maxLength < 16) {
		throw new TypeError('PDF translation chunk length must be an integer of at least 16 characters');
	}
	let remaining = markdown.trim();
	if (!remaining) return [];
	const chunks: string[] = [];
	const minimumBoundary = Math.floor(maxLength * 0.9);
	const separators = ['\n\n', '\n', '. ', '。', '！', '？', '; ', '；', ', ', '，', ' '] as const;
	while (remaining.length > maxLength) {
		let end = maxLength;
		let consumedSeparator = 0;
		for (const separator of separators) {
			const boundary = remaining.lastIndexOf(separator, maxLength - separator.length);
			if (boundary < minimumBoundary) continue;
			end = boundary + (separator.trim() ? separator.length : 0);
			consumedSeparator = separator.trim() ? 0 : separator.length;
			break;
		}
		const chunk = remaining.slice(0, end).trim();
		if (!chunk) throw new Error('PDF translation chunking made no progress');
		chunks.push(chunk);
		remaining = remaining.slice(end + consumedSeparator).trimStart();
	}
	if (remaining) chunks.push(remaining.trimEnd());
	return chunks;
}
