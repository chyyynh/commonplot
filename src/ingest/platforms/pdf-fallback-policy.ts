import { usablePdfMarkdown } from './pdf-text.ts';

export const LLAMA_PARSE_MAX_PAGES = 100;

const PAID_FALLBACK_DEFECTS = new Set(['empty-output', 'garbled-text', 'needs-ocr', 'parse-failed', 'unparsed']);

export type PaidPdfFallbackGrant = Readonly<{ maxPages: number }>;

type LocalPdfFallbackSummary = Readonly<{
	hardDefects: readonly string[];
	totalPages: number | null;
}>;

export type LlamaParseFallbackReason =
	| 'admitted'
	| 'invalid-grant'
	| 'local-usable'
	| 'missing-credentials'
	| 'not-authorized'
	| 'page-count-unknown'
	| 'page-limit-exceeded'
	| 'source-ineligible';

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

export function llamaParseFallbackReason(input: {
	grant: PaidPdfFallbackGrant | null;
	hasCredentials: boolean;
	local: LocalPdfFallbackSummary;
	sourceUrl: string;
}): LlamaParseFallbackReason {
	if (!input.local.hardDefects.some((reason) => PAID_FALLBACK_DEFECTS.has(reason))) return 'local-usable';
	if (!input.grant) return 'not-authorized';
	if (!Number.isInteger(input.grant.maxPages) || input.grant.maxPages < 1 || input.grant.maxPages > LLAMA_PARSE_MAX_PAGES)
		return 'invalid-grant';
	if (!input.hasCredentials) return 'missing-credentials';
	if (input.local.totalPages === null) return 'page-count-unknown';
	if (input.local.totalPages < 1 || input.local.totalPages > input.grant.maxPages) return 'page-limit-exceeded';
	return isAllowedPublicPdfUrl(input.sourceUrl) ? 'admitted' : 'source-ineligible';
}

type MarkdownPage = Readonly<{ markdown?: string; page_number: number; success: boolean }>;

/** Accept only a complete, exactly-once page set; never persist a truncated cloud result. */
export function wholeDocumentMarkdown(pages: readonly MarkdownPage[] | null | undefined, expectedPages: number): string | null {
	if (pages?.length !== expectedPages || expectedPages < 1 || expectedPages > LLAMA_PARSE_MAX_PAGES) return null;
	const ordered = [...pages].sort((left, right) => left.page_number - right.page_number);
	if (ordered.some((page, index) => !page.success || page.page_number !== index + 1 || typeof page.markdown !== 'string')) return null;
	const sanitized = ordered.map((page) => {
		const raw = page.markdown ?? '';
		const clean = usablePdfMarkdown(raw, false);
		return raw.trim() && !clean ? null : clean;
	});
	if (sanitized.some((page) => page === null)) return null;
	return sanitized.join('\n\n').trim() || null;
}
