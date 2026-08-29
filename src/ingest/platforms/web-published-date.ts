// Publication-date recovery for generic web articles.
//
// `@extractus/article-extractor` resolves a date from a meta-tag list, a
// JSON-LD `@type` allowlist that omits `BlogPosting`, and a text fallback that
// only recognizes ISO and slash dates. Independent blogs routinely miss all
// three and yield an empty string, which leaves the resource without a
// published date and therefore out of the chronological feed. These passes run
// after the extractor and are ordered by descending confidence.

const MIN_PUBLISHED_YEAR = 1990;
// Publisher clocks and timezone-less dates can sit slightly ahead of ours.
const FUTURE_TOLERANCE_MS = 2 * 24 * 60 * 60 * 1000;
const LD_JSON_BLOCK = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const LD_DATE_KEYS = ['datePublished', 'dateCreated', 'uploadDate'];
const LD_MAX_DEPTH = 6;
// Only tags that could carry a machine-readable date, to keep the scan bounded.
const DATE_CARRIER_TAG = /<[a-z][a-z0-9-]*\b[^>]*\b(?:datetime|itemprop)\s*=\s*["'][^"']*["'][^>]*>/gi;
const CARRIER_VALUE = /\b(?:datetime|content)\s*=\s*["']([^"']+)["']/i;
const PUBLISHED_ITEMPROP = /\bitemprop\s*=\s*["'][^"']*\bdate(?:Published|Created)\b[^"']*["']/i;
const TIME_TAG = /^<time\b/i;
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const TEXT_DATE = new RegExp(
	`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b` +
		`|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{4}\\b` +
		'|\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?\\b',
	'i',
);
const ORDINAL_SUFFIX = /(\d{1,2})(?:st|nd|rd|th)\b/gi;
// Publishers emit `2026/08/28T01:32:19+09:00`, which no Date parser accepts.
const SLASHED_ISO_DATE = /^(\d{4})\/(\d{2})\/(\d{2})/;
const BARE_YEAR = /^\d{4}$/;
const REMOVED_ELEMENT = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_TAG = /<[^>]+>/g;

/** Parses a candidate into an ISO instant, rejecting values that cannot be a publication date. */
export function normalizePublishedDate(value: string | null | undefined): string | null {
	const candidate = value?.trim().replace(ORDINAL_SUFFIX, '$1').replace(SLASHED_ISO_DATE, '$1-$2-$3');
	// A bare year parses to January 1st, which would sort as a real date it is not.
	if (!candidate || BARE_YEAR.test(candidate)) return null;
	const parsed = new Date(candidate);
	const time = parsed.getTime();
	if (!Number.isFinite(time)) return null;
	if (parsed.getUTCFullYear() < MIN_PUBLISHED_YEAR) return null;
	if (time > Date.now() + FUTURE_TOLERANCE_MS) return null;
	return parsed.toISOString();
}

function ldDateFromNode(node: unknown, depth: number): string | null {
	if (depth > LD_MAX_DEPTH || node === null || typeof node !== 'object') return null;
	if (Array.isArray(node)) {
		for (const entry of node) {
			const found = ldDateFromNode(entry, depth + 1);
			if (found) return found;
		}
		return null;
	}
	const record = node as Record<string, unknown>;
	for (const key of LD_DATE_KEYS) {
		const value = record[key];
		// Schema.org allows a bare year or `YYYY-MM`; both are still usable.
		const normalized = typeof value === 'string' ? normalizePublishedDate(value) : null;
		if (normalized) return normalized;
	}
	for (const value of Object.values(record)) {
		const found = ldDateFromNode(value, depth + 1);
		if (found) return found;
	}
	return null;
}

/** Reads any JSON-LD publication date, without the extractor's `@type` allowlist. */
function ldJsonDate(html: string): string | null {
	for (const block of html.matchAll(LD_JSON_BLOCK)) {
		const raw = block[1]?.trim();
		if (!raw) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const found = ldDateFromNode(parsed, 0);
		if (found) return found;
	}
	return null;
}

/** Reads the first `<time datetime>` or `itemprop="datePublished"` carrier in document order. */
function attributeDate(html: string): string | null {
	for (const tag of html.matchAll(DATE_CARRIER_TAG)) {
		const element = tag[0];
		if (!TIME_TAG.test(element) && !PUBLISHED_ITEMPROP.test(element)) continue;
		const normalized = normalizePublishedDate(element.match(CARRIER_VALUE)?.[1]);
		if (normalized) return normalized;
	}
	return null;
}

/** Reads the first human-readable date in visible text, which is how most blogs render bylines. */
function textDate(html: string): string | null {
	const text = html.replace(REMOVED_ELEMENT, ' ').replace(HTML_TAG, ' ');
	return normalizePublishedDate(text.match(TEXT_DATE)?.[0]);
}

/**
 * Resolves a publication date for an extracted web article. The article body is
 * searched before the full page so a byline wins over unrelated chrome such as
 * sidebars, related links, and copyright lines.
 */
export function resolveArticlePublishedDate(input: { articleHtml: string; extracted: string | null; pageHtml: string }): string | null {
	return (
		normalizePublishedDate(input.extracted) ??
		ldJsonDate(input.pageHtml) ??
		attributeDate(input.articleHtml) ??
		attributeDate(input.pageHtml) ??
		textDate(input.articleHtml) ??
		textDate(input.pageHtml)
	);
}
