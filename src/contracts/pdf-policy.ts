import { z } from 'zod';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const PDF_MIME = 'application/pdf';

const LLAMA_PARSE_MAX_PAGES = 100;
const FULL_PAGE_IMAGE_FALLBACK_RATIO = 0.8;
const DOCUMENT_FALLBACK_REASONS = new Set(['empty-output', 'parse-failed']);

export const PaidPdfFallbackGrantSchema = z.strictObject({ maxPages: z.int().min(1).max(LLAMA_PARSE_MAX_PAGES) });
export type PaidPdfFallbackGrant = Readonly<z.infer<typeof PaidPdfFallbackGrantSchema>>;
type LlamaParseSource = Readonly<{ kind: 'private-upload' }> | Readonly<{ kind: 'public-url'; url: string }>;

export type LocalPdfSummary = Readonly<{
	fallbackReasons: readonly string[];
	fullPageImagePages: number;
	parserVersion: string;
	totalPages: number | null;
}>;

/** Route image-backed PDFs only when the signal describes the document, not an isolated cover page. */
function localPdfNeedsFallback(local: Pick<LocalPdfSummary, 'fallbackReasons' | 'fullPageImagePages' | 'totalPages'>): boolean {
	return (
		local.fallbackReasons.some((reason) => DOCUMENT_FALLBACK_REASONS.has(reason)) ||
		(local.totalPages !== null && local.totalPages > 0 && local.fullPageImagePages / local.totalPages >= FULL_PAGE_IMAGE_FALLBACK_RATIO)
	);
}

function isAllowedPublicPdfUrl(value: string): boolean {
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
