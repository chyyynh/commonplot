import { paperIdentityFromText } from '../shared/paper-identity.ts';

const HEADING_LINE = /^ {0,3}(#{1,4})\s+(.+?)\s*$/;
const REFERENCES_HEADING =
	/^\**\s*(?:[\d.]+\s+)?(?:references?|bibliography|works cited|literature cited)(?:\s*(?:and|&)\s*notes)?\s*\**$/i;
const PLAIN_HEADING = /^\s*(?:\*\*)?[A-Z][A-Za-z\s&.]*(?:\*\*)?\s*$/;

const MAX_ENTRIES = 1_000;
export const MAX_REFERENCE_TEXT_CHARS = 600;
const MIN_ENTRIES = 3;
const MAX_MARKER_GAP = { anywhere: 4, lineStart: 24 } as const;

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/i;

const ENTRY_STYLES = [
	{ gap: MAX_MARKER_GAP.anywhere, numbered: true, pattern: /\[(\d{1,4})\]/g },
	{ gap: MAX_MARKER_GAP.lineStart, numbered: true, pattern: /^ {0,3}(\d{1,4})\.\s+/gm },
	{ gap: 0, numbered: false, pattern: /^ {0,3}[*-]\s+/gm },
] as const;

type EntrySpan = { end: number; marker: number | null; start: number };

export type ResourceReference = Readonly<{
	arxivId: string | null;
	doi: string | null;
	marker: number | null;
	ordinal: number;
	text: string;
	url: string | null;
}>;

function referencesSection(markdown: string): string | null {
	const lines = markdown.split('\n');
	let start = -1;
	lines.forEach((line, index) => {
		const heading = HEADING_LINE.exec(line);
		if (heading && REFERENCES_HEADING.test(heading[2] ?? '')) start = index + 1;
	});
	if (start < 0) {
		lines.forEach((line, index) => {
			if (PLAIN_HEADING.test(line) && REFERENCES_HEADING.test(line.trim())) start = index + 1;
		});
	}
	if (start < 0) return null;
	const end = lines.findIndex((line, index) => index >= start && HEADING_LINE.test(line));
	return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function entrySpans(section: string, style: (typeof ENTRY_STYLES)[number]): EntrySpan[] {
	const spans: EntrySpan[] = [];
	const pattern = new RegExp(style.pattern);
	let expected = 1;
	for (let match = pattern.exec(section); match !== null && spans.length < MAX_ENTRIES; match = pattern.exec(section)) {
		if (style.numbered) {
			const marker = Number(match[1]);
			if (marker < expected || marker > expected + style.gap) continue;
			expected = marker + 1;
		}
		const previous = spans.at(-1);
		if (previous) previous.end = match.index;
		spans.push({
			end: section.length,
			marker: style.numbered ? Number(match[1]) : null,
			start: match.index + match[0].length,
		});
	}
	return spans;
}

function cleanEntryText(raw: string): string {
	const text = raw
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s*-{3,}\s*$/gm, ' ')
		.replace(/([a-z])-\n\s*([a-z])/g, '$1$2')
		.replace(/[*_]{1,3}/g, '')
		.replace(/\\([[\]])/g, '$1')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.,;:]+|[\s,;:]+$/g, '');
	return text.length > MAX_REFERENCE_TEXT_CHARS ? `${text.slice(0, MAX_REFERENCE_TEXT_CHARS - 1).trimEnd()}…` : text;
}

function trimTrailingPunctuation(value: string): string {
	return value.replace(/[.,;:]+$/, '');
}

function validatedHttpUrl(value: string | undefined): string | null {
	if (!value) return null;
	const url = URL.parse(trimTrailingPunctuation(value));
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
	return url.toString();
}

function entryLinks(raw: string): Pick<ResourceReference, 'arxivId' | 'doi' | 'url'> {
	const { arxivId = null, doi = null } = paperIdentityFromText(raw) ?? {};
	return {
		arxivId,
		doi,
		url: doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : validatedHttpUrl(URL_PATTERN.exec(raw)?.[0]),
	};
}

/** Conservatively mine the ordered printed bibliography from extracted Markdown. */
export function bibliographyFromMarkdown(markdown: string): ResourceReference[] {
	const section = referencesSection(markdown);
	if (!section) return [];
	const spans = ENTRY_STYLES.map((style) => entrySpans(section, style)).reduce(
		(best, candidate) => (candidate.length > best.length ? candidate : best),
		[] as EntrySpan[],
	);
	if (spans.length < MIN_ENTRIES) return [];
	return spans.flatMap((span, index) => {
		const raw = section.slice(span.start, span.end);
		const text = cleanEntryText(raw);
		return text ? [{ marker: span.marker, ordinal: index + 1, text, ...entryLinks(raw) }] : [];
	});
}
