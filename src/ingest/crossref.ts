import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import { normalizeDoi } from '../shared/paper-identity.ts';
import { readBoundedResponseText } from '../shared/response.ts';

const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const CROSSREF_CONTACT = 'hello@newsence.app';
const CROSSREF_USER_AGENT = `Newsence/1.0 (https://www.newsence.app; mailto:${CROSSREF_CONTACT})`;
const CROSSREF_TIMEOUT_MS = 12_000;
const MAX_CITATION_QUERY_CHARS = 600;
const MAX_CROSSREF_SEARCH_BYTES = 256 * 1024;
const MAX_CROSSREF_WORK_BYTES = 8 * 1024 * 1024;
const CROSSREF_ROWS = 3;
const MAX_AUTHOR_QUERY_CHARS = 300;
const MAX_TITLE_QUERY_CHARS = 500;
const CROSSREF_PAPER_TYPES = new Set(['dissertation', 'journal-article', 'posted-content', 'proceedings-article', 'report']);

const CrossrefWorkSchema = z.object({
	DOI: z.string(),
	author: z.array(z.object({ family: z.string().nullish(), given: z.string().nullish(), name: z.string().nullish() })).nullish(),
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
const CrossrefPublicationDateSchema = z.iso.date();

type CrossrefWork = z.infer<typeof CrossrefWorkSchema>;

function normalizeBibliographicText(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{Mark}/gu, '')
		.toLocaleLowerCase('en-US')
		.replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function significantTokens(value: string): string[] {
	return [...new Set(value.split(' ').filter((token) => token.length >= 3))];
}

function publishedYear(work: CrossrefWork): number | null {
	const year = work.published?.['date-parts'][0]?.[0];
	return typeof year === 'number' && Number.isInteger(year) && year >= 1800 && year <= 2199 ? year : null;
}

function normalizedAuthorNames(work: CrossrefWork): string[] {
	return (work.author ?? [])
		.slice(0, 3)
		.map(({ family, name }) => normalizeBibliographicText(family?.trim() || name || ''))
		.filter((name) => name.length >= 3);
}

function metadataText(value: string | null | undefined): string | null {
	return value?.replace(/\s+/g, ' ').trim() || null;
}

function workAuthors(work: CrossrefWork): string[] {
	return (work.author ?? []).flatMap(({ family, given, name }) => {
		const author = metadataText(name?.trim() || [given, family].filter(Boolean).join(' '));
		return author ? [author] : [];
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

	const authorMatches = normalizedAuthorNames(work).some((name) => ` ${citationText} `.includes(` ${name} `));
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
	if (!metadataText(work['container-title']?.[0]) || publishedYear(work) === null) return false;

	const candidateAuthors = authors.map(normalizeBibliographicText);
	return normalizedAuthorNames(work).some((name) => candidateAuthors.some((author) => ` ${author} `.includes(` ${name} `)));
}

function crossrefResolution(work: CrossrefWork) {
	const doi = normalizeDoi(work.DOI);
	if (!doi) return null;
	const [, month, day] = work.published?.['date-parts'][0] ?? [];
	const year = publishedYear(work);
	const date = CrossrefPublicationDateSchema.safeParse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`).data;
	const title = metadataText(work.title?.[0]);
	const venue = metadataText(work['container-title']?.[0]);
	return {
		doi,
		authors: workAuthors(work),
		...(work['is-referenced-by-count'] == null ? {} : { citedByCount: work['is-referenced-by-count'] }),
		...(date ? { publicationDate: date } : {}),
		...(work['references-count'] == null ? {} : { referenceCount: work['references-count'] }),
		...(title ? { title } : {}),
		...(venue ? { venue } : {}),
		...(year === null ? {} : { year }),
	};
}

async function fetchCrossref(params: Readonly<Record<string, string>>, doi?: string): Promise<unknown> {
	const url = new URL(doi ? `${CROSSREF_WORKS_URL}/${encodeURIComponent(doi)}` : CROSSREF_WORKS_URL);
	url.search = new URLSearchParams({ mailto: CROSSREF_CONTACT, ...params }).toString();
	const response = await fetch(url, {
		headers: { Accept: 'application/json', 'User-Agent': CROSSREF_USER_AGENT },
		signal: AbortSignal.timeout(CROSSREF_TIMEOUT_MS),
	});
	if (!response.ok) {
		const retryAfter = response.headers.get('retry-after')?.slice(0, 100);
		await response.body?.cancel();
		if (doi && response.status === 404) return null;
		const ErrorType = [400, 401, 403, 404, 410, 422].includes(response.status) ? NonRetryableError : Error;
		throw new ErrorType(`Crossref request failed with HTTP ${response.status}${retryAfter ? `; retry_after=${retryAfter}` : ''}`);
	}
	if (!response.body) throw new Error('Crossref response had no body');
	return JSON.parse(
		await readBoundedResponseText(response, doi ? MAX_CROSSREF_WORK_BYTES : MAX_CROSSREF_SEARCH_BYTES, 'Crossref response'),
	);
}

export async function resolveCrossrefReferenceDoi(citation: string) {
	const query = citation.trim();
	if (!query) throw new TypeError('Crossref citation must not be empty');
	const response = await fetchCrossref({
		'query.bibliographic': query.slice(0, MAX_CITATION_QUERY_CHARS),
		rows: String(CROSSREF_ROWS),
		select: 'DOI,title,author,published',
	});
	const matches = CrossrefResponseSchema.parse(response).message.items.filter((work) => workMatchesCitation(query, work));
	return matches.map((work) => normalizeDoi(work.DOI)).find(Boolean) ?? null;
}

export async function resolveCrossrefPaperCandidate(title: string, authors: readonly string[]) {
	const queryTitle = title.trim();
	const queryAuthor = authors[0]?.trim();
	if (!queryTitle || !queryAuthor) throw new TypeError('Crossref paper title and author must not be empty');
	const response = await fetchCrossref({
		'query.author': queryAuthor.slice(0, MAX_AUTHOR_QUERY_CHARS),
		'query.title': queryTitle.slice(0, MAX_TITLE_QUERY_CHARS),
		rows: String(CROSSREF_ROWS),
		select: 'DOI,title,author,published,container-title,type,is-referenced-by-count,references-count',
	});
	const matches = CrossrefResponseSchema.parse(response).message.items.filter((work) =>
		workMatchesPaperCandidate(queryTitle, authors, work),
	);
	return matches.map(crossrefResolution).find(Boolean) ?? null;
}

export async function resolveCrossrefPaper(doi: string) {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) throw new TypeError('Crossref paper DOI is invalid');
	const response = await fetchCrossref({}, normalizedDoi);
	if (response === null) return null;
	const { message: work } = z.object({ status: z.literal('ok'), message: CrossrefWorkSchema }).parse(response);
	return normalizeDoi(work.DOI) === normalizedDoi ? crossrefResolution(work) : null;
}
