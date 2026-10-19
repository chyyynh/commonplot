import { cleanText } from './markdown';

/** Display fields parsed from one bibliography entry; each field is null when the entry does not expose it reliably. */
export type ReferenceCitation = {
	title: string | null;
	year: number | null;
	/** The entry's author list as printed, for readers that show the full citation. */
	authors: string | null;
	leadAuthor: string | null;
	hasCoauthors: boolean;
	venue: string | null;
};

const YEAR = String.raw`(?:19|20)\d{2}`;
const PARTICLE = String.raw`(?:van|von|der|den|de|del|da|di|du|le|la)`;
const LOCATOR_CUT = /\s*(?:\bURL(?=\s|h|:)|https?\s*:|\bdoi\s*:|\bDOI\b|\bAccessed\b|\bRetrieved\b|\[?\s*Online\]|\barXiv\s*:\s*\d)/iu;
/** `J.`, `J.S.`, `D.-M.`, or undotted Sage/Vancouver initials such as `EN`. */
const INITIALS = String.raw`(?:\p{L}\.(?:\s?[-‐]?\p{L}\.)*|\p{Lu}{1,2}(?=\s*[,;&(]|\s+(?:and|et al)\b|\s*$))`;
const SURNAME = String.raw`(?:${PARTICLE}\s+)*\p{Lu}[\p{L}'’\-]*(?:\s+(?:\p{Lu}\p{Ll}[\p{L}'’\-]*|${PARTICLE}))*`;
const AUTHOR_SEPARATOR = String.raw`(?:\s*[,;]?\s*(?:&|and)\s+|\s*[,;]\s*)`;
/** `Surname, I. J.` or `Surname IJ` author lists, as used by Nature, APA, Sage and several journals. */
const SURNAME_FIRST_LIST = new RegExp(
	String.raw`^${SURNAME}(?:,\s*|\s+)${INITIALS}(?:${AUTHOR_SEPARATOR}${SURNAME}(?:,\s*|\s+)${INITIALS})*(?:,?\s*et\s+al\.)?`,
	'u',
);
const SURNAME_FIRST_START = new RegExp(String.raw`^${SURNAME}(?:,\s*|\s+)${INITIALS}`, 'u');
const PSEUDO_AUTHORS = new Set(['online', 'anonymous', 'n.d', 'unknown', 'website', 'web']);
const ORGANIZATION =
	/\b(?:Corporation|Corp|Inc|Ltd|LLC|Team|Collaboration|Research|Institute|University|Foundation|Labs?|Group|Committee|Association|Organi[sz]ation|Council|Project|Systems|Agency|Department|Office|Commission|Consortium|Society|Network)\b/u;

function trimPunctuation(value: string): string {
	return cleanText(value)
		.replace(/^[\s"“'‘,.;:]+|[\s"”'’,.;:]+$/gu, '')
		.trim();
}

function parseYear(value: string | undefined): number | null {
	const year = Number(value?.slice(0, 4));
	return Number.isInteger(year) && year >= 1800 && year <= 2100 ? year : null;
}

/** First `.` that ends a sentence rather than an initial, abbreviation or version number. */
function sentenceEnd(value: string): number {
	// A question-mark title directly followed by its venue: `…science? Proc. Natl Acad.` or `…enough? Qualitative health research 27, 4`.
	const question = /[?!](?=\s+\p{Lu}\p{L}*\.\s|\s+\p{Lu}[^.?!]{2,100}?\s\d+\s*[,(:])/u.exec(value)?.index ?? Infinity;
	for (const match of value.matchAll(/\.(?=\s|\p{Lu}|arXiv|$)/gu)) {
		if (match.index > question) break;
		const before = value.slice(0, match.index);
		const token = /[\p{L}\d]+$/u.exec(before)?.[0] ?? '';
		if (/^\p{Lu}$/u.test(token)) continue;
		if (/^(?:Jr|Sr|St|vs|Vol|No|Proc|Natl|Acad|Sci|Int|Conf|Rev|Eds?|pp|Dr|Mr|Ms|Mrs)$/u.test(token)) continue;
		if (/\d$/u.test(before) && /^\s?\d/u.test(value.slice(match.index + 1))) continue;
		return match.index;
	}
	return Number.isFinite(question) ? question + 1 : -1;
}

function authorSummary(
	authors: string,
	surnameFirst = SURNAME_FIRST_START.test(authors),
): Pick<ReferenceCitation, 'authors' | 'leadAuthor' | 'hasCoauthors'> {
	const hasEtAl = /\bet\s+al\b/u.test(authors);
	const body = cleanText(authors.replace(/,?\s*\bet\s+al\b\.?/gu, '')).replace(/[.,;]$/u, '');
	if (!body || PSEUDO_AUTHORS.has(body.toLowerCase())) return { authors: null, leadAuthor: null, hasCoauthors: false };
	// The year split can take the final initial's period: `Cai, J. (2024)` → `Cai, J`.
	const printed = cleanText(authors)
		.replace(/[,;:]$/u, '')
		.replace(/(\p{Lu}\.[^]*\s\p{Lu})$/u, '$1.');
	if (surnameFirst) {
		const surname = new RegExp(`^${SURNAME}`, 'u').exec(body)?.[0] ?? null;
		const rest = surname ? body.slice(surname.length) : '';
		return { authors: printed, leadAuthor: surname, hasCoauthors: hasEtAl || /&|\band\b|;|,\s*\p{Lu}\p{Ll}/u.test(rest) };
	}
	const entries = body
		.split(/\s*(?:,\s*and\s+|,\s+|\s+and\s+|\s*&\s*)\s*/u)
		.map((entry) => entry.trim())
		.filter(Boolean);
	const first = entries[0] ?? body;
	const hasCoauthors = hasEtAl || entries.length > 1;
	if (entries.length === 1 && (ORGANIZATION.test(first) || !/\s/u.test(first)))
		return { authors: printed, leadAuthor: first, hasCoauthors };
	const tokens = first.split(/\s+/u);
	let start = tokens.length - 1;
	while (start > 0 && new RegExp(`^${PARTICLE}$`, 'u').test(tokens[start - 1]!)) start -= 1;
	const surname = tokens.slice(start).join(' ');
	return { authors: printed, leadAuthor: /\p{L}{2}/u.test(surname) ? surname : null, hasCoauthors };
}

function normalizeVenue(value: string): string | null {
	const venue = trimPunctuation(value);
	if (/\barxiv\b/iu.test(venue)) return 'arXiv';
	if (venue.length < 2 || venue.length > 160 || /^(?:online|url)\b/iu.test(venue) || new RegExp(`^${YEAR}$`, 'u').test(venue)) return null;
	return venue;
}

function titleAndVenue(rest: string): Pick<ReferenceCitation, 'title' | 'venue'> {
	const body = cleanText(rest.split(LOCATOR_CUT)[0] ?? '');
	const quoted = /^["“]([^"”]{3,})["”],?\s*/u.exec(body);
	const end = quoted ? quoted[0].length - 1 : sentenceEnd(body);
	const title = trimPunctuation(
		(quoted ? quoted[1]! : end < 0 ? body : body.slice(0, end)).replace(
			new RegExp(String.raw`,\s*(?:\p{Lu}\p{Ll}+\.?\s+\d{1,2},\s*)?${YEAR}[a-z]?$`, 'u'),
			'',
		),
	);
	const venue =
		end < 0
			? null
			: normalizeVenue(
					body
						.slice(end + 1)
						.replace(/^\s*In(?:\s*:\s*|\s+|(?=\p{Lu}))/u, '')
						.replace(/^[^.]{1,120}\(eds?\.?\)\s*/u, '')
						.split(
							/\s*(?:,\s*(?:pp?\.|pages?|vol\.|volume)|\(|,\s*\d|\s\d+\s*[,(:]|\.\s+(?=\d|\p{Lu}[\p{L}]{2,}[\s,])|\s*[,.]\s*\p{Lu}[\p{L} ]+:\s)/iu,
						)[0] ?? '',
				);
	return { title: title.length >= 2 && title.length <= 400 && !/^\d+$/u.test(title) ? title : null, venue };
}

function citationYear(text: string): number | null {
	const body = text
		.replace(/\b(?:Accessed|Retrieved)\b[^.]*(?:\.|$)/giu, ' ')
		.replace(/\b(?:https?\s*:\s*\/\/|doi\s*:\s*|arXiv\s*:\s*)\S+/giu, ' ');
	const parenthesized = new RegExp(String.raw`\((?:[^()]*\s)?(${YEAR})[a-z]?\)`, 'gu');
	const standalone = new RegExp(String.raw`(?<![\d.:/\-–])(${YEAR})[a-z]?(?![\d\-–]|\.\d)`, 'gu');
	return parseYear([...body.matchAll(parenthesized)].at(-1)?.[1] ?? [...body.matchAll(standalone)].at(-1)?.[1]);
}

/** Author lists have no digits, no sentence break and no run of lowercase words, unlike a title ending in `, 2025.` */
function looksLikeAuthorList(value: string): boolean {
	const words = value.replace(new RegExp(String.raw`\b(?:and|et al\.?|${PARTICLE})(?=\s|$)`, 'gu'), ' ');
	return !/\d/u.test(value) && sentenceEnd(words) < 0 && !/(?:^|\s)\p{Ll}{2,}\s+\p{Ll}{2,}/u.test(words);
}

/**
 * Parse the common bibliography styles (ACM, NeurIPS/ICML, Nature, APA, Sage) into display fields.
 * Unrecognized entries keep null fields; readers fall back to the raw reference text. Fields the source marked up
 * itself, such as LaTeXML's author and title spans and the year in its entry tag, win over parsing.
 */
export function parseReferenceCitation(
	value: string,
	marked: Partial<Record<'authors' | 'title' | 'year', string>> = {},
): ReferenceCitation {
	const parsed = parsePrintedCitation(value);
	const authors = cleanText(marked.authors);
	const title = trimPunctuation(marked.title ?? '');
	const year = marked.year === undefined ? null : citationYear(cleanText(marked.year));
	return {
		...parsed,
		...(authors ? authorSummary(authors) : {}),
		...(title ? { title } : {}),
		...(year ? { year } : {}),
	};
}

function parsePrintedCitation(value: string): ReferenceCitation {
	const text = cleanText(value);
	// IEEE: `Authors, “Title,” Venue, Year.`
	const ieee = /^(.{2,600}?),\s*[“"]([^”"]{2,400}?)[,.]?[”"],?\s*(.*)$/u.exec(text);
	if (ieee && looksLikeAuthorList(ieee[1]!)) {
		const venue = normalizeVenue(
			(ieee[3]!.split(LOCATOR_CUT)[0] ?? '').split(/,\s*(?:vol\.|no\.|pp\.|\p{Lu}\p{Ll}+\.?\s+\d|\d)/u)[0] ?? '',
		);
		return {
			...authorSummary(ieee[1]!),
			year: citationYear(text),
			title: trimPunctuation(ieee[2]!) || null,
			venue: venue && !/^(?:\p{Lu}\p{Ll}+\.?\s+)?\d/u.test(venue) ? venue : null,
		};
	}
	// Year right after the author list: `Authors. 2024. Title` (ACM) or `Authors (2024). Title` (APA, Sage).
	const leadingYear = new RegExp(
		String.raw`^(.{2,600}?)(?:\.\s*|\s+|,\s*)[(\[]?(${YEAR}[a-z]?|in press|n\.\s?d\.)[)\]]?[.,]?\s*(?=\S)`,
		'iu',
	).exec(text);
	if (leadingYear && looksLikeAuthorList(leadingYear[1]!)) {
		return {
			...authorSummary(leadingYear[1]!),
			year: parseYear(leadingYear[2]),
			...titleAndVenue(text.slice(leadingYear[0].length)),
		};
	}
	const surnameFirst = SURNAME_FIRST_LIST.exec(text)?.[0] ?? '';
	const etAl = /\bet\s+al\./u.exec(text);
	const firstEnd = sentenceEnd(text);
	const authorEnd =
		surnameFirst.length >= 4
			? surnameFirst.length
			: etAl && etAl.index < 600 && (firstEnd < 0 || firstEnd >= etAl.index)
				? etAl.index + etAl[0].length
				: firstEnd;
	const authors = authorEnd > 0 && authorEnd <= 600 ? text.slice(0, authorEnd) : '';
	const parsed = titleAndVenue(authors ? text.slice(authorEnd).replace(/^[.\s]+/u, '') : text);
	const year = citationYear(text);
	return {
		...(authors ? authorSummary(authors, surnameFirst.length >= 4) : { authors: null, leadAuthor: null, hasCoauthors: false }),
		year,
		...parsed,
	};
}
