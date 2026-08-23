import { assessPdfTexts, type PdfTextSanitationSummary, stripUnsafePdfText } from './pdf-text-quality.ts';
import {
	assemblePdfWorkingDocument,
	type PdfPageQualityV1,
	type PdfWorkingDocumentV1,
	type PdfWorkingPageV1,
} from './pdf-working-document.ts';

export const PDF_ENHANCEMENT_POLICY_REVISION = 'selective-llamaparse-v2' as const;
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

export type SelectiveLlamaParseV2Page = Readonly<{
	pageNumber: number;
	text: string;
	markdown: string;
	sanitation: PdfTextSanitationSummary;
}>;

export type SelectiveLlamaParseV2Result = Readonly<{
	provider: 'llamaparse';
	apiVersion: 'v2';
	version: string;
	pages: SelectiveLlamaParseV2Page[];
	failedPages: ReadonlyArray<Readonly<{ pageNumber: number; message: string }>>;
	usageCredits: number | null;
}>;

type ProviderPageState = {
	markdown?: string;
	markdownFailure?: string;
	text?: string;
};

const EMPTY_IMAGE_QUALITY: PdfPageQualityV1['images'] = {
	hasSubstantialImages: false,
	blockCount: 0,
	coverage: 0,
	largestCoverage: 0,
	fullPage: false,
};

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

export function detectPdfEnhancementPages(document: PdfWorkingDocumentV1): PdfEnhancementPage[] {
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

export function planSelectivePdfEnhancement(document: PdfWorkingDocumentV1): SelectivePdfEnhancementPlan | null {
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
		providerFile: { purpose: 'parse', cleanup: 'delete-after-terminal-job' },
		usageAccounting: { settlement: 'provider-reported-credits', targetPageBilling: 'unverified' },
	};
}

// The durable result is Markdown, so request only channels used to validate and publish it.
export const LLAMAPARSE_V2_RESULT_EXPAND = ['text', 'markdown', 'usage'] as const;

function invalidProviderResponse(path: string, expectation: string): never {
	throw new Error(`Invalid LlamaParse v2 response: ${path} must be ${expectation}`);
}

function providerRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidProviderResponse(path, 'an object');
	return value as Record<string, unknown>;
}

function providerArray(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) return invalidProviderResponse(path, 'an array');
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

function providerInteger(value: unknown, path: string, minimum: number): number {
	const number = providerFiniteNumber(value, path);
	if (!Number.isInteger(number) || number < minimum) {
		return invalidProviderResponse(path, `an integer greater than or equal to ${minimum}`);
	}
	return number;
}

function cleanProviderText(value: unknown, path: string): string {
	return stripUnsafePdfText(providerString(value, path)).trim();
}

function providerFailureMessage(value: unknown, path: string): string {
	if (typeof value === 'string') return stripUnsafePdfText(value).trim().slice(0, 500) || 'Provider processing failed';
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (typeof record.message === 'string') {
			return stripUnsafePdfText(record.message).trim().slice(0, 500) || 'Provider processing failed';
		}
	}
	if (value !== undefined && value !== null) providerRecord(value, path);
	return 'Provider processing failed';
}

function extractedTextChars(value: string): number {
	return value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
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

function providerUsageCredits(job: Record<string, unknown>): number | null {
	if (job.usage === undefined || job.usage === null) return null;
	const usage = providerRecord(job.usage, 'job.usage');
	if (usage.credits === undefined || usage.credits === null) return null;
	const credits = providerFiniteNumber(usage.credits, 'job.usage.credits');
	if (credits < 0) return invalidProviderResponse('job.usage.credits', 'non-negative');
	return credits;
}

function normalizedProviderPage(pageNumber: number, state: ProviderPageState): SelectiveLlamaParseV2Page | string {
	const missing: string[] = [];
	if (state.markdownFailure) missing.push(`markdown: ${state.markdownFailure}`);
	else if (state.markdown === undefined) missing.push('markdown result missing');
	if (state.text === undefined) missing.push('text result missing');
	if (missing.length > 0) return missing.join('; ').slice(0, 500);

	const rawText = state.text;
	const rawMarkdown = state.markdown;
	if (rawText === undefined || rawMarkdown === undefined) return 'Provider result channels were incomplete';
	const sanitation = assessPdfTexts([rawText, rawMarkdown]);
	const text = stripUnsafePdfText(rawText).trim();
	const markdown = stripUnsafePdfText(rawMarkdown).trim();
	if (sanitation.isGarbled) return 'Provider page output failed binary-text sanitation';
	if (extractedTextChars(markdown) === 0 && extractedTextChars(text) === 0) {
		return 'Provider page output contained no usable text';
	}
	return { pageNumber, text, markdown, sanitation };
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

	const pages: SelectiveLlamaParseV2Page[] = [];
	const failedPages: Array<{ pageNumber: number; message: string }> = [];
	for (const pageNumber of targetNumbers) {
		const state = states.get(pageNumber);
		if (!state) throw new Error(`Missing target-page state for ${pageNumber}`);
		const normalized = normalizedProviderPage(pageNumber, state);
		if (typeof normalized === 'string') failedPages.push({ pageNumber, message: normalized });
		else pages.push(normalized);
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

function enhancedWorkingPage(providerPage: SelectiveLlamaParseV2Page, localPage: PdfWorkingPageV1 | undefined): PdfWorkingPageV1 {
	return {
		pageNumber: providerPage.pageNumber,
		width: localPage?.width ?? null,
		height: localPage?.height ?? null,
		source: 'llamaparse',
		text: providerPage.text,
		markdown: providerPage.markdown,
		usable: true,
		quality: {
			needsOcr: false,
			isGarbled: false,
			reasons: [],
			textLength: providerPage.text.length,
			textCoverage: localPage?.quality.textCoverage ?? 0,
			pageArea: localPage?.quality.pageArea ?? null,
			images: localPage?.quality.images ?? EMPTY_IMAGE_QUALITY,
			uncoveredVectorArea: localPage?.quality.uncoveredVectorArea ?? null,
			layout: null,
			sanitation: providerPage.sanitation,
		},
	};
}

export function mergeSelectivePdfEnhancement(
	document: PdfWorkingDocumentV1,
	plan: SelectivePdfEnhancementPlan,
	result: SelectiveLlamaParseV2Result,
): PdfWorkingDocumentV1 {
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

	const applied = new Set(appliedPages);
	const pageByNumber = new Map(document.pages.map((page) => [page.pageNumber, page]));
	for (const page of result.pages) {
		pageByNumber.set(page.pageNumber, enhancedWorkingPage(page, pageByNumber.get(page.pageNumber)));
	}
	const assembled = assemblePdfWorkingDocument(
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
