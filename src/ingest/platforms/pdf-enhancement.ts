import {
	assembleLiteParseDocument,
	type ParsedDocumentBlockV1,
	type ParsedDocumentCellV1,
	type ParsedDocumentPageV1,
	type ParsedDocumentV1,
} from './parsed-document.ts';
import { assessPdfTexts, stripUnsafePdfText } from './pdf-text-quality.ts';

export const PDF_ENHANCEMENT_POLICY_REVISION = 'selective-llamaparse-v1' as const;
export const LLAMAPARSE_V2_AGENTIC_VERSION = '2026-08-19' as const;

export type PdfEnhancementReason = 'complex-layout' | 'garbled-text' | 'needs-ocr' | 'parse-failed' | 'unparsed';

export type PdfEnhancementPage = Readonly<{
	pageNumber: number;
	reasons: PdfEnhancementReason[];
}>;

/** ParseRequestConfiguration fragment; the provider client adds file_id after upload. */
export type SelectiveLlamaParseV2Configuration = Readonly<{
	tier: 'agentic';
	version: typeof LLAMAPARSE_V2_AGENTIC_VERSION;
	client_name: 'newsence-core';
	page_ranges: Readonly<{ target_pages: string }>;
	output_options: Readonly<{
		additional_outputs: [];
		granular_bboxes: [];
		images_to_save: [];
		save_output_pdf: false;
	}>;
}>;

export type SelectivePdfEnhancementPlan = Readonly<{
	provider: 'llamaparse';
	apiVersion: 'v2';
	policyRevision: typeof PDF_ENHANCEMENT_POLICY_REVISION;
	totalPages: number;
	targetPages: PdfEnhancementPage[];
	parseConfiguration: SelectiveLlamaParseV2Configuration;
	providerFile: Readonly<{
		purpose: 'parse';
		cleanup: 'delete-after-terminal-job';
	}>;
	usageAccounting: Readonly<{
		settlement: 'provider-reported-credits';
		targetPageBilling: 'unverified';
	}>;
}>;

function assertTotalPages(totalPages: number): void {
	if (!Number.isInteger(totalPages) || totalPages < 1) {
		throw new TypeError('PDF total page count must be a positive integer');
	}
}

function canonicalTargetPageNumbers(pageNumbers: readonly number[], totalPages: number): number[] {
	assertTotalPages(totalPages);
	if (pageNumbers.length === 0) throw new TypeError('LlamaParse target pages must not be empty');
	for (const pageNumber of pageNumbers) {
		if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
			throw new TypeError(`LlamaParse target page ${pageNumber} is outside the 1-${totalPages} source page range`);
		}
	}
	return [...new Set(pageNumbers)].sort((left, right) => left - right);
}

/** Format the exact 1-based page grammar accepted by LlamaParse v2. */
export function formatLlamaParseTargetPages(pageNumbers: readonly number[], totalPages: number): string {
	const pages = canonicalTargetPageNumbers(pageNumbers, totalPages);
	const ranges: string[] = [];
	let start = pages[0];
	let end = start;
	for (const page of pages.slice(1)) {
		if (page === end + 1) {
			end = page;
			continue;
		}
		ranges.push(start === end ? `${start}` : `${start}-${end}`);
		start = page;
		end = page;
	}
	ranges.push(start === end ? `${start}` : `${start}-${end}`);
	return ranges.join(',');
}

export function detectPdfEnhancementPages(document: ParsedDocumentV1): PdfEnhancementPage[] {
	assertTotalPages(document.totalPages);
	const reasonsByPage = new Map<number, Set<PdfEnhancementReason>>();
	const addReason = (pageNumber: number, reason: PdfEnhancementReason) => {
		const reasons = reasonsByPage.get(pageNumber) ?? new Set<PdfEnhancementReason>();
		reasons.add(reason);
		reasonsByPage.set(pageNumber, reasons);
	};
	const coveredPages = new Set<number>();
	for (const page of document.pages) {
		coveredPages.add(page.pageNumber);
		if (page.quality.needsOcr) addReason(page.pageNumber, 'needs-ocr');
		if (page.quality.isGarbled) addReason(page.pageNumber, 'garbled-text');
		if (page.quality.layout?.isComplex) addReason(page.pageNumber, 'complex-layout');
	}
	for (const error of document.pageErrors) {
		coveredPages.add(error.pageNumber);
		addReason(error.pageNumber, 'parse-failed');
	}
	for (let pageNumber = 1; pageNumber <= document.totalPages; pageNumber += 1) {
		if (!coveredPages.has(pageNumber)) addReason(pageNumber, 'unparsed');
	}
	return [...reasonsByPage]
		.sort(([left], [right]) => left - right)
		.map(([pageNumber, reasons]) => ({ pageNumber, reasons: [...reasons].sort() }));
}

export function buildSelectiveLlamaParseV2Configuration(
	targetPages: readonly number[],
	totalPages: number,
): SelectiveLlamaParseV2Configuration {
	return {
		tier: 'agentic',
		version: LLAMAPARSE_V2_AGENTIC_VERSION,
		client_name: 'newsence-core',
		page_ranges: { target_pages: formatLlamaParseTargetPages(targetPages, totalPages) },
		output_options: {
			additional_outputs: [],
			granular_bboxes: [],
			images_to_save: [],
			save_output_pdf: false,
		},
	};
}

export function planSelectivePdfEnhancement(document: ParsedDocumentV1): SelectivePdfEnhancementPlan | null {
	const targetPages = detectPdfEnhancementPages(document);
	if (targetPages.length === 0) return null;
	return {
		provider: 'llamaparse',
		apiVersion: 'v2',
		policyRevision: PDF_ENHANCEMENT_POLICY_REVISION,
		totalPages: document.totalPages,
		targetPages,
		parseConfiguration: buildSelectiveLlamaParseV2Configuration(
			targetPages.map((page) => page.pageNumber),
			document.totalPages,
		),
		providerFile: {
			purpose: 'parse',
			cleanup: 'delete-after-terminal-job',
		},
		usageAccounting: {
			settlement: 'provider-reported-credits',
			targetPageBilling: 'unverified',
		},
	};
}

export const LLAMAPARSE_V2_RESULT_EXPAND = ['text', 'markdown', 'items', 'usage'] as const;

export type SelectiveLlamaParseV2Result = Readonly<{
	provider: 'llamaparse';
	apiVersion: 'v2';
	version: string;
	pages: ParsedDocumentPageV1[];
	failedPages: ReadonlyArray<Readonly<{ pageNumber: number; message: string }>>;
	usageCredits: number | null;
}>;

type ProviderPageState = {
	markdown?: string;
	markdownFailure?: string;
	text?: string;
	structured?: Readonly<{ width: number; height: number; items: unknown[] }>;
	structuredFailure?: string;
};

type NormalizedProviderBlock = Readonly<{
	block: ParsedDocumentBlockV1;
	rawTexts: string[];
}>;

const MAX_PROVIDER_ITEMS_PER_PAGE = 10_000;
const MAX_PROVIDER_TABLE_CELLS = 100_000;

function invalidProviderResponse(path: string, expectation: string): never {
	throw new Error(`Invalid LlamaParse v2 response: ${path} must be ${expectation}`);
}

function providerRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidProviderResponse(path, 'an object');
	return value as Record<string, unknown>;
}

function providerArray(value: unknown, path: string, maximum = Number.POSITIVE_INFINITY): unknown[] {
	if (!Array.isArray(value)) return invalidProviderResponse(path, 'an array');
	if (value.length > maximum) return invalidProviderResponse(path, `an array with at most ${maximum} entries`);
	return value;
}

function providerString(value: unknown, path: string): string {
	if (typeof value !== 'string') return invalidProviderResponse(path, 'a string');
	return value;
}

function providerBoolean(value: unknown, path: string): boolean {
	if (typeof value !== 'boolean') return invalidProviderResponse(path, 'a boolean');
	return value;
}

function providerFiniteNumber(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return invalidProviderResponse(path, 'a finite number');
	return Object.is(value, -0) ? 0 : value;
}

function providerInteger(value: unknown, path: string, minimum: number, maximum = Number.POSITIVE_INFINITY): number {
	const number = providerFiniteNumber(value, path);
	if (!Number.isInteger(number) || number < minimum || number > maximum) {
		return invalidProviderResponse(path, `an integer between ${minimum} and ${maximum}`);
	}
	return number;
}

function cleanProviderText(value: unknown, path: string): string {
	return stripUnsafePdfText(providerString(value, path)).trim();
}

function providerFailureMessage(value: unknown, path: string): string {
	const message = cleanProviderText(value, path).slice(0, 500);
	return message || 'Provider page processing failed';
}

function tableCell(value: unknown, path: string): Readonly<{ cell: ParsedDocumentCellV1; rawText: string | null }> {
	if (value === null) return { cell: { text: '', bbox: null }, rawText: null };
	if (typeof value === 'number') return { cell: { text: `${providerFiniteNumber(value, path)}`, bbox: null }, rawText: null };
	const rawText = providerString(value, path);
	return { cell: { text: stripUnsafePdfText(rawText).trim(), bbox: null }, rawText };
}

function providerTableRows(value: unknown, path: string): Readonly<{ rows: ParsedDocumentCellV1[][]; rawTexts: string[] }> {
	const rawRows = providerArray(value, path);
	let cellCount = 0;
	const rawTexts: string[] = [];
	const rows = rawRows.map((rawRow, rowIndex) => {
		const rawCells = providerArray(rawRow, `${path}[${rowIndex}]`);
		cellCount += rawCells.length;
		if (cellCount > MAX_PROVIDER_TABLE_CELLS) {
			return invalidProviderResponse(path, `a table with at most ${MAX_PROVIDER_TABLE_CELLS} cells`);
		}
		return rawCells.map((value, cellIndex) => {
			const normalized = tableCell(value, `${path}[${rowIndex}][${cellIndex}]`);
			if (normalized.rawText !== null) rawTexts.push(normalized.rawText);
			return normalized.cell;
		});
	});
	return { rows, rawTexts };
}

function commonBlock(
	pageNumber: number,
	index: number,
	sourceKind: string,
	type: ParsedDocumentBlockV1['type'],
	text: string | null,
): ParsedDocumentBlockV1 {
	return {
		id: `p${pageNumber}-b${index + 1}`,
		type,
		sourceKind,
		// The v2 schema does not define bbox origin. Do not mix unverified
		// provider coordinates into the canonical top-left PDF-point system.
		bbox: null,
		text,
		style: { bold: false, italic: false },
		heading: null,
		list: null,
		code: null,
		table: null,
		figure: null,
	};
}

function normalizedProviderBlock(value: unknown, pageNumber: number, index: number): NormalizedProviderBlock {
	const path = `items.pages[${pageNumber}].items[${index}]`;
	const item = providerRecord(value, path);
	const sourceKind = providerString(item.type, `${path}.type`);
	const rawMarkdown = providerString(item.md, `${path}.md`);
	const markdown = stripUnsafePdfText(rawMarkdown).trim();
	const rawTexts = [rawMarkdown];

	if (sourceKind === 'text') {
		const rawText = providerString(item.value, `${path}.value`);
		rawTexts.push(rawText);
		return { block: commonBlock(pageNumber, index, sourceKind, 'paragraph', stripUnsafePdfText(rawText).trim() || null), rawTexts };
	}
	if (sourceKind === 'heading') {
		const rawText = providerString(item.value, `${path}.value`);
		rawTexts.push(rawText);
		const block = commonBlock(pageNumber, index, sourceKind, 'heading', stripUnsafePdfText(rawText).trim() || null);
		return { block: { ...block, heading: { level: providerInteger(item.level, `${path}.level`, 1, 6) } }, rawTexts };
	}
	if (sourceKind === 'list') {
		providerArray(item.items, `${path}.items`, MAX_PROVIDER_ITEMS_PER_PAGE);
		const block = commonBlock(pageNumber, index, sourceKind, 'list', markdown || null);
		return {
			block: { ...block, list: { level: null, marker: null, ordered: providerBoolean(item.ordered, `${path}.ordered`) } },
			rawTexts,
		};
	}
	if (sourceKind === 'code') {
		const rawText = providerString(item.value, `${path}.value`);
		rawTexts.push(rawText);
		const text = stripUnsafePdfText(rawText).trim();
		const rawLanguage = item.language === undefined || item.language === null ? null : providerString(item.language, `${path}.language`);
		if (rawLanguage !== null) rawTexts.push(rawLanguage);
		const block = commonBlock(pageNumber, index, sourceKind, 'code', text || null);
		return {
			block: { ...block, code: { language: rawLanguage ? stripUnsafePdfText(rawLanguage).trim() || null : null, lines: text.split('\n') } },
			rawTexts,
		};
	}
	if (sourceKind === 'table') {
		providerString(item.html, `${path}.html`);
		providerString(item.csv, `${path}.csv`);
		const table = providerTableRows(item.rows, `${path}.rows`);
		rawTexts.push(...table.rawTexts);
		const rows = table.rows;
		const text = rows
			.map((row) => row.map((cell) => cell.text).join('\t'))
			.join('\n')
			.trim();
		return {
			block: {
				...commonBlock(pageNumber, index, sourceKind, 'table', text || markdown || null),
				table: { header: [], rows, fallbackLines: [] },
			},
			rawTexts,
		};
	}
	if (sourceKind === 'image') {
		const rawCaption = providerString(item.caption, `${path}.caption`);
		providerString(item.url, `${path}.url`);
		rawTexts.push(rawCaption);
		const block = commonBlock(pageNumber, index, sourceKind, 'figure', stripUnsafePdfText(rawCaption).trim() || markdown || null);
		return { block: { ...block, figure: { id: null, format: null } }, rawTexts };
	}
	if (sourceKind === 'link') {
		const rawText = providerString(item.text, `${path}.text`);
		providerString(item.url, `${path}.url`);
		rawTexts.push(rawText);
		return { block: commonBlock(pageNumber, index, sourceKind, 'paragraph', stripUnsafePdfText(rawText).trim() || null), rawTexts };
	}
	if (sourceKind === 'header' || sourceKind === 'footer') {
		providerArray(item.items, `${path}.items`, MAX_PROVIDER_ITEMS_PER_PAGE);
		return { block: commonBlock(pageNumber, index, sourceKind, 'paragraph', markdown || null), rawTexts };
	}
	return invalidProviderResponse(`${path}.type`, 'a supported structured item discriminator');
}

function extractedTextChars(value: string): number {
	return value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function buildProviderPage(pageNumber: number, state: ProviderPageState): Readonly<{ page: ParsedDocumentPageV1 } | { failure: string }> {
	const missing: string[] = [];
	if (state.markdownFailure) missing.push(`markdown: ${state.markdownFailure}`);
	else if (state.markdown === undefined) missing.push('markdown result missing');
	if (state.structuredFailure) missing.push(`items: ${state.structuredFailure}`);
	else if (!state.structured) missing.push('structured result missing');
	if (state.text === undefined) missing.push('text result missing');
	if (missing.length > 0) return { failure: missing.join('; ').slice(0, 500) };

	const structured = state.structured;
	const rawText = state.text;
	const rawMarkdown = state.markdown;
	if (!structured || rawText === undefined || rawMarkdown === undefined) {
		return { failure: 'Provider result channels were incomplete' };
	}
	const normalizedBlocks = structured.items.map((item, index) => normalizedProviderBlock(item, pageNumber, index));
	const sanitation = assessPdfTexts([rawText, rawMarkdown, ...normalizedBlocks.flatMap((entry) => entry.rawTexts)]);
	const text = stripUnsafePdfText(rawText).trim();
	const markdown = stripUnsafePdfText(rawMarkdown).trim();
	if (sanitation.isGarbled) return { failure: 'Provider page output failed binary-text sanitation' };
	if (extractedTextChars(markdown) === 0 && extractedTextChars(text) === 0) {
		return { failure: 'Provider page output contained no usable text' };
	}
	const pageArea = structured.width * structured.height;
	if (!Number.isFinite(pageArea) || pageArea <= 0) {
		return invalidProviderResponse(`items.pages[${pageNumber}]`, 'a page with finite positive area');
	}
	return {
		page: {
			pageNumber,
			width: structured.width,
			height: structured.height,
			source: 'llamaparse',
			text,
			markdown,
			usable: true,
			quality: {
				needsOcr: false,
				isGarbled: false,
				reasons: [],
				textLength: text.length,
				textCoverage: 0,
				pageArea,
				images: {
					hasSubstantialImages: normalizedBlocks.some((entry) => entry.block.type === 'figure'),
					blockCount: normalizedBlocks.filter((entry) => entry.block.type === 'figure').length,
					coverage: 0,
					largestCoverage: 0,
					fullPage: false,
				},
				uncoveredVectorArea: null,
				layout: null,
				sanitation,
			},
			blocks: normalizedBlocks.map((entry) => entry.block),
		},
	};
}

function targetPageNumber(value: unknown, path: string, targets: ReadonlySet<number>, seen: Set<number>): number {
	const pageNumber = providerInteger(value, path, 1);
	if (!targets.has(pageNumber)) return invalidProviderResponse(path, 'one of the requested target pages');
	if (seen.has(pageNumber)) return invalidProviderResponse(path, 'unique within its result channel');
	seen.add(pageNumber);
	return pageNumber;
}

function collectMarkdownPages(value: unknown, states: Map<number, ProviderPageState>, targets: ReadonlySet<number>): void {
	const result = providerRecord(value, 'markdown');
	const seen = new Set<number>();
	for (const [index, valuePage] of providerArray(result.pages, 'markdown.pages').entries()) {
		const path = `markdown.pages[${index}]`;
		const page = providerRecord(valuePage, path);
		const pageNumber = targetPageNumber(page.page_number, `${path}.page_number`, targets, seen);
		const state = states.get(pageNumber);
		if (!state) throw new Error(`Missing target-page state for ${pageNumber}`);
		if (providerBoolean(page.success, `${path}.success`)) state.markdown = providerString(page.markdown, `${path}.markdown`);
		else state.markdownFailure = providerFailureMessage(page.error, `${path}.error`);
	}
}

function collectTextPages(value: unknown, states: Map<number, ProviderPageState>, targets: ReadonlySet<number>): void {
	const result = providerRecord(value, 'text');
	const seen = new Set<number>();
	for (const [index, valuePage] of providerArray(result.pages, 'text.pages').entries()) {
		const path = `text.pages[${index}]`;
		const page = providerRecord(valuePage, path);
		const pageNumber = targetPageNumber(page.page_number, `${path}.page_number`, targets, seen);
		const state = states.get(pageNumber);
		if (!state) throw new Error(`Missing target-page state for ${pageNumber}`);
		state.text = providerString(page.text, `${path}.text`);
	}
}

function collectStructuredPages(value: unknown, states: Map<number, ProviderPageState>, targets: ReadonlySet<number>): void {
	const result = providerRecord(value, 'items');
	const seen = new Set<number>();
	for (const [index, valuePage] of providerArray(result.pages, 'items.pages').entries()) {
		const path = `items.pages[${index}]`;
		const page = providerRecord(valuePage, path);
		const pageNumber = targetPageNumber(page.page_number, `${path}.page_number`, targets, seen);
		const state = states.get(pageNumber);
		if (!state) throw new Error(`Missing target-page state for ${pageNumber}`);
		if (!providerBoolean(page.success, `${path}.success`)) {
			state.structuredFailure = providerFailureMessage(page.error, `${path}.error`);
			continue;
		}
		const width = providerFiniteNumber(page.page_width, `${path}.page_width`);
		const height = providerFiniteNumber(page.page_height, `${path}.page_height`);
		if (width <= 0 || height <= 0) invalidProviderResponse(path, 'a page with positive dimensions');
		state.structured = {
			width,
			height,
			items: providerArray(page.items, `${path}.items`, MAX_PROVIDER_ITEMS_PER_PAGE),
		};
	}
}

function providerUsageCredits(job: Record<string, unknown>): number | null {
	if (job.usage === undefined || job.usage === null) return null;
	const usage = providerRecord(job.usage, 'job.usage');
	if (usage.credits === undefined || usage.credits === null) return null;
	const credits = providerFiniteNumber(usage.credits, 'job.usage.credits');
	if (credits < 0) return invalidProviderResponse('job.usage.credits', 'non-negative');
	return credits;
}

export function normalizeSelectiveLlamaParseV2Result(value: unknown, plan: SelectivePdfEnhancementPlan): SelectiveLlamaParseV2Result {
	const response = providerRecord(value, 'response');
	const job = providerRecord(response.job, 'job');
	if (!cleanProviderText(job.id, 'job.id')) return invalidProviderResponse('job.id', 'a non-empty string');
	if (providerString(job.status, 'job.status') !== 'COMPLETED') {
		return invalidProviderResponse('job.status', 'COMPLETED before result normalization');
	}
	if (job.tier !== undefined && job.tier !== null && providerString(job.tier, 'job.tier') !== plan.parseConfiguration.tier) {
		return invalidProviderResponse('job.tier', plan.parseConfiguration.tier);
	}
	const targetNumbers = plan.targetPages.map((page) => page.pageNumber);
	const targets = new Set(targetNumbers);
	if (targets.size !== targetNumbers.length || targets.size === 0) {
		throw new TypeError('Selective PDF enhancement plan must contain unique target pages');
	}
	const states = new Map(targetNumbers.map((pageNumber) => [pageNumber, {}]));
	collectMarkdownPages(response.markdown, states, targets);
	collectTextPages(response.text, states, targets);
	collectStructuredPages(response.items, states, targets);

	const pages: ParsedDocumentPageV1[] = [];
	const failedPages: Array<{ pageNumber: number; message: string }> = [];
	for (const pageNumber of targetNumbers) {
		const state = states.get(pageNumber);
		if (!state) throw new Error(`Missing target-page state for ${pageNumber}`);
		const normalized = buildProviderPage(pageNumber, state);
		if ('page' in normalized) pages.push(normalized.page);
		else failedPages.push({ pageNumber, message: normalized.failure });
	}
	return {
		provider: 'llamaparse',
		apiVersion: 'v2',
		version: plan.parseConfiguration.version,
		pages,
		failedPages,
		usageCredits: providerUsageCredits(job),
	};
}

export function mergeSelectivePdfEnhancement(
	document: ParsedDocumentV1,
	plan: SelectivePdfEnhancementPlan,
	result: SelectiveLlamaParseV2Result,
): ParsedDocumentV1 {
	if (plan.totalPages !== document.totalPages) throw new TypeError('PDF enhancement plan does not match the source document');
	if (result.provider !== plan.provider || result.apiVersion !== plan.apiVersion) {
		throw new TypeError('PDF enhancement result provider does not match its plan');
	}
	if (result.version !== plan.parseConfiguration.version) {
		throw new TypeError('PDF enhancement result version does not match its plan');
	}

	const requestedPages = plan.targetPages.map((page) => page.pageNumber);
	const requested = new Set(requestedPages);
	if (requested.size !== requestedPages.length || requested.size === 0) {
		throw new TypeError('PDF enhancement plan target pages must be unique and non-empty');
	}
	const appliedPages = result.pages.map((page) => page.pageNumber);
	const failedPages = result.failedPages.map((page) => page.pageNumber);
	const outcomes = [...appliedPages, ...failedPages];
	if (
		new Set(outcomes).size !== outcomes.length ||
		outcomes.length !== requestedPages.length ||
		outcomes.some((pageNumber) => !requested.has(pageNumber))
	) {
		throw new TypeError('PDF enhancement result must contain exactly one outcome for every requested page');
	}
	for (const page of result.pages) {
		if (page.source !== 'llamaparse') throw new TypeError('PDF enhancement result pages must identify their provider source');
	}

	const applied = new Set(appliedPages);
	const pageByNumber = new Map(document.pages.map((page) => [page.pageNumber, page]));
	for (const page of result.pages) pageByNumber.set(page.pageNumber, page);
	const assembled = assembleLiteParseDocument(
		{
			totalPages: document.totalPages,
			pages: [...pageByNumber.values()].sort((left, right) => left.pageNumber - right.pageNumber),
			pageErrors: document.pageErrors.filter((error) => !applied.has(error.pageNumber)),
		},
		document.parser.version,
	);
	return {
		...assembled,
		parser: document.parser,
		enhancement: {
			provider: result.provider,
			apiVersion: result.apiVersion,
			version: result.version,
			policyRevision: plan.policyRevision,
			requestedPages,
			appliedPages,
			failedPages: result.failedPages,
			usageCredits: result.usageCredits,
		},
	};
}
