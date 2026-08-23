import type { ParsedDocumentV1 } from './parsed-document';

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
