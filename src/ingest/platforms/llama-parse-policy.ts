export const LLAMA_PARSE_MAX_PAGES = 100;

export type LlamaParseFallbackReason =
	| 'admitted'
	| 'disabled'
	| 'local-usable'
	| 'missing-credentials'
	| 'page-count-unknown'
	| 'page-limit-exceeded'
	| 'private-source';

type LocalParseSummary = Readonly<{
	hardDefects: readonly string[];
	totalPages: number | null;
}>;

const PAID_FALLBACK_DEFECTS = new Set(['empty-output', 'garbled-text', 'needs-ocr', 'parse-failed', 'unparsed']);

export function llamaParseFallbackReason(input: {
	enabled: unknown;
	hasApiKey: boolean;
	hasProjectId: boolean;
	local: LocalParseSummary;
	scope: 'private' | 'public';
}): LlamaParseFallbackReason {
	if (!input.local.hardDefects.some((reason) => PAID_FALLBACK_DEFECTS.has(reason))) return 'local-usable';
	if (input.scope === 'private') return 'private-source';
	if (input.enabled !== 'true') return 'disabled';
	if (!input.hasApiKey || !input.hasProjectId) return 'missing-credentials';
	if (input.local.totalPages === null) return 'page-count-unknown';
	return input.local.totalPages <= LLAMA_PARSE_MAX_PAGES ? 'admitted' : 'page-limit-exceeded';
}

export function isAllowedPublicPdfUrl(value: string): boolean {
	const url = URL.parse(value);
	if (url?.protocol !== 'https:' || url.username || url.password || url.port) return false;
	const hostname = url.hostname.toLowerCase();
	if (
		!hostname.includes('.') ||
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal')
	) {
		return false;
	}
	// A hostname is required so DNS and TLS policy remain with the public origin;
	// direct IP literals are never delegated to a third-party fetcher.
	return !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(':');
}

type MarkdownPage = Readonly<{
	markdown?: string;
	page_number: number;
	success: boolean;
}>;

/** Accept only a complete, exactly-once page set; never persist a truncated cloud result. */
export function wholeDocumentMarkdown(pages: readonly MarkdownPage[] | null | undefined, expectedPages: number): string | null {
	if (pages?.length !== expectedPages || expectedPages < 1 || expectedPages > LLAMA_PARSE_MAX_PAGES) return null;
	const ordered = [...pages].sort((left, right) => left.page_number - right.page_number);
	if (ordered.some((page, index) => !page.success || page.page_number !== index + 1 || typeof page.markdown !== 'string')) return null;
	const markdown = ordered
		.map((page) => page.markdown?.trim() ?? '')
		.join('\n\n')
		.trim();
	return markdown || null;
}
