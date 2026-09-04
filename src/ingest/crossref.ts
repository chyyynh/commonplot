import { z } from 'zod';
import { canonicalPaperUrl, normalizeDoi } from '../shared/paper-identity.ts';
import { readBoundedResponseText } from '../shared/response.ts';

const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const CROSSREF_CONTACT = 'hello@newsence.app';
const CROSSREF_USER_AGENT = `Newsence/1.0 (https://www.newsence.app; mailto:${CROSSREF_CONTACT})`;
const CROSSREF_TIMEOUT_MS = 12_000;
const MAX_CITATION_CHARS = 600;
const MAX_CROSSREF_RESPONSE_BYTES = 256 * 1024;
const MAX_NORMALIZED_CITATION_CHARS = 1_200;
const CROSSREF_ROWS = 3;
const MAX_AUTHOR_CHARS = 300;
const MAX_TITLE_CHARS = 500;
const MAX_VENUE_CHARS = 300;
const CROSSREF_PAPER_TYPES = new Set(['dissertation', 'journal-article', 'posted-content', 'proceedings-article', 'report']);

const CrossrefWorkSchema = z.object({
	DOI: z.string(),
	author: z
		.array(z.object({ family: z.string().nullish(), given: z.string().nullish() }))
		.max(100)
		.nullish(),
	'container-title': z.array(z.string()).max(10).nullish(),
	published: z
		.object({
			'date-parts': z.array(z.array(z.number()).min(1).max(3)).min(1).max(3),
		})
		.nullish(),
	'is-referenced-by-count': z.int().nonnegative().nullish(),
	'references-count': z.int().nonnegative().nullish(),
	title: z.array(z.string()).min(1).max(10).nullish(),
	type: z.string().nullish(),
});

const CrossrefResponseSchema = z.object({
	message: z.object({ items: z.array(CrossrefWorkSchema).max(CROSSREF_ROWS) }),
	status: z.literal('ok'),
});

type CrossrefWork = z.infer<typeof CrossrefWorkSchema>;

function normalizeBibliographicText(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{Mark}/gu, '')
		.toLocaleLowerCase('en-US')
		.replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_NORMALIZED_CITATION_CHARS);
}

function significantTokens(value: string): string[] {
	return [...new Set(value.split(' ').filter((token) => token.length >= 3))];
}

function publishedYear(work: CrossrefWork): number | null {
	const year = work.published?.['date-parts'][0]?.[0];
	return typeof year === 'number' && Number.isInteger(year) && year >= 1800 && year <= 2199 ? year : null;
}

function publishedDate(work: CrossrefWork): string | undefined {
	const [, month, day] = work.published?.['date-parts'][0] ?? [];
	const year = publishedYear(work);
	if (
		year === null ||
		typeof month !== 'number' ||
		!Number.isInteger(month) ||
		month < 1 ||
		month > 12 ||
		typeof day !== 'number' ||
		!Number.isInteger(day) ||
		day < 1 ||
		day > 31
	) {
		return undefined;
	}
	const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	const date = new Date(`${candidate}T00:00:00.000Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate ? candidate : undefined;
}

function normalizedFamilyNames(work: CrossrefWork): string[] {
	return (work.author ?? [])
		.slice(0, 3)
		.map(({ family }) => normalizeBibliographicText(family ?? ''))
		.filter((family) => family.length >= 3);
}

function boundedMetadata(value: string | null | undefined, maxChars: number): string | null {
	const normalized = value?.replace(/\s+/g, ' ').trim();
	return normalized ? normalized.slice(0, maxChars) : null;
}

function workAuthors(work: CrossrefWork): string[] {
	return (work.author ?? []).flatMap(({ family, given }) => {
		const name = boundedMetadata([given, family].filter(Boolean).join(' '), MAX_AUTHOR_CHARS);
		return name ? [name] : [];
	});
}

function workMatchesCitation(citation: string, work: CrossrefWork): boolean {
	const citationText = normalizeBibliographicText(citation);
	const titleText = normalizeBibliographicText(work.title?.[0] ?? '');
	if (!citationText || !titleText) return false;

	const titleTokens = significantTokens(titleText);
	if (titleTokens.length < 2) return false;
	const citationTokenSet = new Set(significantTokens(citationText));
	const matchedTitleTokens = titleTokens.filter((token) => citationTokenSet.has(token)).length;
	const titleCoverage = matchedTitleTokens / titleTokens.length;
	const exactTitle = titleText.length >= 12 && citationText.includes(titleText);
	if (!exactTitle && (matchedTitleTokens < 4 || titleCoverage < 0.85)) return false;

	const years = new Set([...citation.matchAll(/\b(?:18|19|20|21)\d{2}\b/g)].map(([year]) => Number(year)));
	const year = publishedYear(work);
	if (years.size && year !== null && !years.has(year)) return false;

	const familyNames = normalizedFamilyNames(work);
	const authorMatches = familyNames.some((family) => citationText.includes(family));
	if (!exactTitle && !authorMatches) return false;
	if (titleTokens.length < 5 && !authorMatches && !(year !== null && years.has(year))) return false;
	return true;
}

function workMatchesPaperCandidate(title: string, authors: readonly string[], work: CrossrefWork): boolean {
	const candidateTitle = normalizeBibliographicText(title);
	const workTitle = normalizeBibliographicText(work.title?.[0] ?? '');
	const shorterTitle = candidateTitle.length <= workTitle.length ? candidateTitle : workTitle;
	const longerTitle = candidateTitle.length <= workTitle.length ? workTitle : candidateTitle;
	if (shorterTitle.length < 18 || shorterTitle.split(' ').length < 4 || !longerTitle.includes(shorterTitle)) return false;
	if (!work.type || !CROSSREF_PAPER_TYPES.has(work.type)) return false;
	if (!boundedMetadata(work['container-title']?.[0], MAX_VENUE_CHARS) || publishedYear(work) === null) return false;

	const authorTokens = new Set(
		authors.flatMap((author) => normalizeBibliographicText(author).split(' ')).filter((token) => token.length >= 3),
	);
	return normalizedFamilyNames(work).some((family) => authorTokens.has(family));
}

function crossrefResolution(work: CrossrefWork) {
	const doi = normalizeDoi(work.DOI);
	const title = boundedMetadata(work.title?.[0], MAX_TITLE_CHARS);
	if (!doi || !title) return null;
	return {
		authors: workAuthors(work),
		doi,
		title,
		url: canonicalPaperUrl({ doi }),
		venue: boundedMetadata(work['container-title']?.[0], MAX_VENUE_CHARS),
		year: publishedYear(work),
	};
}

function selectCrossrefResolution(rawResponse: unknown, matches: (work: CrossrefWork) => boolean) {
	return CrossrefResponseSchema.parse(rawResponse).message.items.filter(matches).map(crossrefResolution).find(Boolean) ?? null;
}

/** Select only a Crossref hit whose deposited metadata strongly agrees with the citation. */
export function selectCrossrefReference(citation: string, rawResponse: unknown) {
	return selectCrossrefResolution(rawResponse, (work) => workMatchesCitation(citation, work));
}

/** Confirm a GROBID header only when Crossref agrees on title, author, work type, venue, and year. */
export function selectCrossrefPaperCandidate(title: string, authors: readonly string[], rawResponse: unknown) {
	return selectCrossrefResolution(rawResponse, (work) => workMatchesPaperCandidate(title, authors, work));
}

export function selectCrossrefPaper(doi: string, rawResponse: unknown) {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) throw new TypeError('Crossref paper DOI is invalid');
	const response = CrossrefResponseSchema.parse(rawResponse);
	const work = response.message.items.find((item) => normalizeDoi(item.DOI) === normalizedDoi);
	if (!work) return null;
	const date = publishedDate(work);
	const title = boundedMetadata(work.title?.[0], MAX_TITLE_CHARS);
	const venue = boundedMetadata(work['container-title']?.[0], MAX_VENUE_CHARS);
	const year = publishedYear(work);
	return {
		authors: workAuthors(work),
		...(work['is-referenced-by-count'] == null ? {} : { citedByCount: work['is-referenced-by-count'] }),
		...(date ? { publicationDate: date } : {}),
		...(work['references-count'] == null ? {} : { referenceCount: work['references-count'] }),
		...(title ? { title } : {}),
		...(venue ? { venue } : {}),
		...(year === null ? {} : { year }),
	};
}

async function fetchCrossrefWorks(params: Readonly<Record<string, string>>): Promise<unknown> {
	const url = new URL(CROSSREF_WORKS_URL);
	url.search = new URLSearchParams({ mailto: CROSSREF_CONTACT, ...params }).toString();
	const response = await fetch(url, {
		headers: { Accept: 'application/json', 'User-Agent': CROSSREF_USER_AGENT },
		signal: AbortSignal.timeout(CROSSREF_TIMEOUT_MS),
	});
	if (!response.ok) {
		const retryAfter = response.headers.get('retry-after')?.slice(0, 100);
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Crossref request failed with HTTP ${status}${retryAfter ? `; retry_after=${retryAfter}` : ''}`);
	}
	if (!response.body) throw new Error('Crossref response had no body');
	return JSON.parse(await readBoundedResponseText(response, MAX_CROSSREF_RESPONSE_BYTES, 'Crossref response'));
}

export async function resolveCrossrefReference(citation: string) {
	const query = citation.trim();
	if (!query || query.length > MAX_CITATION_CHARS) throw new TypeError(`Crossref citation must contain 1-${MAX_CITATION_CHARS} characters`);
	return selectCrossrefReference(
		query,
		await fetchCrossrefWorks({
			'query.bibliographic': query,
			rows: String(CROSSREF_ROWS),
			select: 'DOI,title,author,published,container-title',
		}),
	);
}

export async function resolveCrossrefPaperCandidate(title: string, authors: readonly string[]) {
	const queryTitle = title.trim();
	const queryAuthor = authors[0]?.trim();
	if (!queryTitle || queryTitle.length > MAX_TITLE_CHARS)
		throw new TypeError(`Crossref paper title must contain 1-${MAX_TITLE_CHARS} characters`);
	if (!queryAuthor || queryAuthor.length > MAX_AUTHOR_CHARS) {
		throw new TypeError(`Crossref paper author must contain 1-${MAX_AUTHOR_CHARS} characters`);
	}
	return selectCrossrefPaperCandidate(
		queryTitle,
		authors,
		await fetchCrossrefWorks({
			'query.author': queryAuthor,
			'query.title': queryTitle,
			rows: String(CROSSREF_ROWS),
			select: 'DOI,title,author,published,container-title,type',
		}),
	);
}

export async function resolveCrossrefPaper(doi: string) {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) throw new TypeError('Crossref paper DOI is invalid');
	return selectCrossrefPaper(
		normalizedDoi,
		await fetchCrossrefWorks({
			filter: `doi:${normalizedDoi}`,
			rows: '1',
			select: 'DOI,title,author,published,container-title,is-referenced-by-count,references-count',
		}),
	);
}
