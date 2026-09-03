export type CitationMentionForAlignment = Readonly<{
	context: string;
	markerText: string;
	referenceOrdinals: number[];
	section: string | null;
}>;

export type AlignedCitationMention = CitationMentionForAlignment &
	Readonly<{
		contentEnd: number | null;
		contentStart: number | null;
	}>;

type TextToken = Readonly<{
	end: number;
	start: number;
	value: string;
}>;

const TOKEN_PATTERN = /[\p{Letter}\p{Number}]+/gu;
const EXTRACTION_MARKUP_PATTERN = /<\/[A-Za-z][A-Za-z0-9_-]*\s*>|<(?:b|strong|em|i|u|sup|sub|span|font|br)(?:\s[^<>]*)?\s*\/?>/gi;
const FALLBACK_WINDOW_TOKENS = 16;
const MARKER_SEARCH_PADDING_CHARS = 32;

function normalizeToken(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{Mark}/gu, '')
		.toLocaleLowerCase('en-US');
}

function tokenize(value: string): TextToken[] {
	// Keep every replacement the same length so token offsets still point into
	// the canonical Markdown. LiteParse occasionally emits citation text as
	// malformed pseudo-HTML (for example, `<Mattern (2020)</Mattern>`); masking
	// only the extraction markup prevents the closing tag name from breaking an
	// otherwise exact GROBID context match.
	const alignableValue = value.replace(EXTRACTION_MARKUP_PATTERN, (markup) => ' '.repeat(markup.length));
	return [...alignableValue.matchAll(TOKEN_PATTERN)].map((match) => ({
		end: (match.index ?? 0) + match[0].length,
		start: match.index ?? 0,
		value: normalizeToken(match[0]),
	}));
}

/** Return at most two hits; a second hit is enough to reject an ambiguous alignment. */
function sequenceHits(haystack: readonly TextToken[], needle: readonly TextToken[], candidateStarts?: readonly number[]): number[] {
	if (!needle.length || needle.length > haystack.length) return [];
	const hits: number[] = [];
	const starts = candidateStarts ?? Array.from({ length: haystack.length - needle.length + 1 }, (_, index) => index);
	for (const start of starts) {
		if (start > haystack.length - needle.length) break;
		if (haystack[start]?.value !== needle[0]?.value) continue;
		let matches = true;
		for (let offset = 1; offset < needle.length; offset += 1) {
			if (haystack[start + offset]?.value !== needle[offset]?.value) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		hits.push(start);
		if (hits.length === 2) break;
	}
	return hits;
}

function uniqueMarkerOffset(markdown: string, markerText: string, start: number, end: number): number | null {
	const paddedStart = Math.max(0, start - MARKER_SEARCH_PADDING_CHARS);
	const paddedEnd = Math.min(markdown.length, end + MARKER_SEARCH_PADDING_CHARS);
	const segment = markdown.slice(paddedStart, paddedEnd);
	const first = segment.indexOf(markerText);
	if (first < 0 || segment.indexOf(markerText, first + markerText.length) >= 0) return null;
	return paddedStart + first;
}

function contextWindow(contextTokens: readonly TextToken[], markerText: string): readonly TextToken[] | null {
	const markerTokens = tokenize(markerText);
	const markerHits = sequenceHits(contextTokens, markerTokens);
	if (markerHits.length !== 1) return null;
	const markerStart = markerHits[0] ?? 0;
	const markerMiddle = markerStart + Math.floor(markerTokens.length / 2);
	const desiredStart = markerMiddle - Math.floor(FALLBACK_WINDOW_TOKENS / 2);
	const start = Math.max(0, Math.min(desiredStart, contextTokens.length - FALLBACK_WINDOW_TOKENS));
	return contextTokens.slice(start, start + Math.min(FALLBACK_WINDOW_TOKENS, contextTokens.length));
}

function alignOneMention(
	markdown: string,
	markdownTokens: readonly TextToken[],
	markdownTokenStarts: ReadonlyMap<string, readonly number[]>,
	mention: CitationMentionForAlignment,
): AlignedCitationMention {
	const contextTokens = tokenize(mention.context);
	let matchingTokens: readonly TextToken[] = contextTokens;
	let hits = sequenceHits(markdownTokens, matchingTokens, markdownTokenStarts.get(matchingTokens[0]?.value ?? ''));
	if (hits.length !== 1) {
		const fallback = contextWindow(contextTokens, mention.markerText);
		if (!fallback || fallback.length < FALLBACK_WINDOW_TOKENS) {
			return { ...mention, contentEnd: null, contentStart: null };
		}
		matchingTokens = fallback;
		hits = sequenceHits(markdownTokens, matchingTokens, markdownTokenStarts.get(matchingTokens[0]?.value ?? ''));
	}
	if (hits.length !== 1) return { ...mention, contentEnd: null, contentStart: null };

	const firstToken = markdownTokens[hits[0] ?? -1];
	const lastToken = markdownTokens[(hits[0] ?? 0) + matchingTokens.length - 1];
	if (!firstToken || !lastToken) return { ...mention, contentEnd: null, contentStart: null };
	const contentStart = uniqueMarkerOffset(markdown, mention.markerText, firstToken.start, lastToken.end);
	if (contentStart === null) return { ...mention, contentEnd: null, contentStart: null };
	const contentEnd = contentStart + mention.markerText.length;
	if (markdown.slice(contentStart, contentEnd) !== mention.markerText) {
		return { ...mention, contentEnd: null, contentStart: null };
	}
	return { ...mention, contentEnd, contentStart };
}

/**
 * Map GROBID sentence contexts to canonical Markdown without guessing. Every
 * persisted offset is backed by one unique token sequence and an exact marker
 * slice; ambiguous relationships keep their context but no inline position.
 */
export function alignCitationMentions(markdown: string, mentions: readonly CitationMentionForAlignment[]): AlignedCitationMention[] {
	const markdownTokens = tokenize(markdown);
	const markdownTokenStarts = new Map<string, number[]>();
	for (const [index, token] of markdownTokens.entries()) {
		const starts = markdownTokenStarts.get(token.value) ?? [];
		starts.push(index);
		markdownTokenStarts.set(token.value, starts);
	}
	return mentions.map((mention) => alignOneMention(markdown, markdownTokens, markdownTokenStarts, mention));
}
