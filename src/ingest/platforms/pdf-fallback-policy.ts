import { normalizeExtractedPdfMarkdown } from '../extracted-pdf-markdown.ts';
import type { normalizeStructuredPdf } from '../zotero-sdt.ts';

export const LLAMA_PARSE_MAX_PAGES = 100;
const FULL_PAGE_IMAGE_FALLBACK_RATIO = 0.8;
const DOCUMENT_FALLBACK_REASONS = new Set(['empty-output', 'parse-failed']);

export type PaidPdfFallbackGrant = Readonly<{ maxPages: number }>;
export type LlamaParseSource = Readonly<{ kind: 'private-upload' }> | Readonly<{ kind: 'public-url'; url: string }>;

type StructuredPdfSummary = ReturnType<typeof normalizeStructuredPdf>['parse'];
export type LocalPdfSummary = Omit<StructuredPdfSummary, 'totalPages' | 'visual'> & {
	totalPages: number | null;
	/** Absent when the parser could not inspect the document at all. */
	visual?: StructuredPdfSummary['visual'];
};

/** Route image-backed PDFs only when the signal describes the document, not an isolated cover page. */
export function localPdfNeedsFallback(local: Pick<LocalPdfSummary, 'fallbackReasons' | 'fullPageImagePages' | 'totalPages'>): boolean {
	return (
		local.fallbackReasons.some((reason) => DOCUMENT_FALLBACK_REASONS.has(reason)) ||
		(local.totalPages !== null && local.totalPages > 0 && local.fullPageImagePages / local.totalPages >= FULL_PAGE_IMAGE_FALLBACK_RATIO)
	);
}

export function isAllowedPublicPdfUrl(value: string): boolean {
	const url = URL.parse(value);
	if (url?.protocol !== 'https:' || url.username || url.password || url.port) return false;
	const hostname = url.hostname.toLowerCase();
	if (
		!hostname.includes('.') ||
		hostname.endsWith('.') ||
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal')
	) {
		return false;
	}
	return !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(':');
}

export function llamaParseAdmissionReason(input: {
	grant: PaidPdfFallbackGrant | null;
	hasCredentials: boolean;
	local: Pick<LocalPdfSummary, 'fallbackReasons' | 'fullPageImagePages' | 'totalPages'>;
	source: LlamaParseSource;
}) {
	if (!localPdfNeedsFallback(input.local)) return 'local-usable';
	if (!input.grant) return 'not-authorized';
	if (!Number.isInteger(input.grant.maxPages) || input.grant.maxPages < 1 || input.grant.maxPages > LLAMA_PARSE_MAX_PAGES)
		return 'invalid-grant';
	if (!input.hasCredentials) return 'missing-credentials';
	if (input.local.totalPages === null) return 'page-count-unknown';
	if (input.local.totalPages < 1 || input.local.totalPages > input.grant.maxPages) return 'page-limit-exceeded';
	if (input.source.kind === 'private-upload') return 'admitted';
	return isAllowedPublicPdfUrl(input.source.url) ? 'admitted' : 'source-ineligible';
}

type MarkdownPage = Readonly<{ markdown?: string; page_number: number; success: boolean }>;

/** Accept only a complete, exactly-once page set; never persist a truncated cloud result. */
export function wholeDocumentMarkdown(pages: readonly MarkdownPage[] | null | undefined, expectedPages: number): string | null {
	if (pages?.length !== expectedPages || expectedPages < 1 || expectedPages > LLAMA_PARSE_MAX_PAGES) return null;
	const ordered = [...pages].sort((left, right) => left.page_number - right.page_number);
	if (ordered.some((page, index) => !page.success || page.page_number !== index + 1 || typeof page.markdown !== 'string')) return null;
	return (
		normalizeExtractedPdfMarkdown(
			ordered
				.map((page) => page.markdown)
				.join('\n\n')
				.replaceAll('\0', '')
				.trim(),
		) || null
	);
}
