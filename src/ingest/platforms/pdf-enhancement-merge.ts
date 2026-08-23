import type { SelectiveLlamaParseV2Result } from './llamaparse-result.ts';
import { assembleLiteParseDocument, type ParsedDocumentV1 } from './parsed-document.ts';
import type { SelectivePdfEnhancementPlan } from './pdf-enhancement.ts';

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
