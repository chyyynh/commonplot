import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import { normalizeBibliographicText, normalizeDoi } from '../shared/paper-identity.ts';
import { readBoundedResponseText } from '../shared/response.ts';

const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const CROSSREF_CONTACT = 'hello@newsence.app';
const CROSSREF_USER_AGENT = `Newsence/1.0 (https://www.newsence.app; mailto:${CROSSREF_CONTACT})`;
const CROSSREF_TIMEOUT_MS = 12_000;
const MAX_CITATION_QUERY_CHARS = 600;
const MAX_CROSSREF_SEARCH_BYTES = 256 * 1024;
const MAX_CROSSREF_WORK_BYTES = 8 * 1024 * 1024;
const CROSSREF_ROWS = 3;

const CrossrefWorkSchema = z.object({
	DOI: z.string(),
	author: z.array(z.object({ family: z.string().nullish(), name: z.string().nullish() })).nullish(),
	published: z
		.object({
			'date-parts': z.array(z.array(z.number()).min(1).max(3)).min(1).max(3),
		})
		.nullish(),
	title: z.array(z.string()).min(1).max(10).nullish(),
});

const CrossrefResponseSchema = z.object({
	message: z.object({ items: z.array(CrossrefWorkSchema).max(CROSSREF_ROWS) }),
	status: z.literal('ok'),
});

type CrossrefWork = z.infer<typeof CrossrefWorkSchema>;

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
	const dois = [...new Set(matches.map((work) => normalizeDoi(work.DOI)).filter((doi) => doi !== null))];
	return dois.length === 1 ? dois[0]! : null;
}

const CrossrefDepositedReferencesSchema = z.object({
	status: z.literal('ok'),
	message: z.object({
		DOI: z.string(),
		reference: z
			.array(
				z.object({
					DOI: z.string().nullish(),
					'article-title': z.string().nullish(),
					unstructured: z.string().nullish(),
				}),
			)
			.max(5_000)
			.nullish(),
	}),
});

/** The reference list a publisher deposited with the paper's DOI; only entries with a DOI can enrich a citation. */
export async function fetchCrossrefDepositedReferences(doi: string) {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) throw new NonRetryableError('Crossref paper DOI is invalid');
	const response = await fetchCrossref({}, normalizedDoi);
	if (response === null) return [];
	const { message } = CrossrefDepositedReferencesSchema.parse(response);
	if (normalizeDoi(message.DOI) !== normalizedDoi) return [];
	return (message.reference ?? []).flatMap((reference) => {
		const referenceDoi = normalizeDoi(reference.DOI);
		const title = reference['article-title'] ? normalizeBibliographicText(reference['article-title']) : '';
		const text = reference.unstructured ? normalizeBibliographicText(reference.unstructured) : '';
		return referenceDoi && (title || text) ? [{ doi: referenceDoi, title, text }] : [];
	});
}

type CrossrefDepositedReference = Awaited<ReturnType<typeof fetchCrossrefDepositedReferences>>[number];

function tokenCoverage(expected: string, actual: ReadonlySet<string>): number {
	const tokens = significantTokens(expected);
	return tokens.length ? tokens.filter((token) => actual.has(token)).length / tokens.length : 0;
}

/** Pair each printed citation with the one deposited entry whose title or text it reproduces. */
export function matchDepositedReferences<T extends { text: string }>(
	printed: readonly T[],
	deposited: readonly CrossrefDepositedReference[],
): (T & { doi: string })[] {
	const unused = new Set(deposited);
	return printed.flatMap((citation) => {
		const text = normalizeBibliographicText(citation.text);
		const tokens = new Set(significantTokens(text));
		const matches = [...unused].filter(
			(entry) =>
				(entry.title.length >= 12 && significantTokens(entry.title).length >= 3 && text.includes(entry.title)) ||
				(!!entry.text && tokenCoverage(entry.text, tokens) >= 0.85 && tokenCoverage(text, new Set(significantTokens(entry.text))) >= 0.85),
		);
		if (new Set(matches.map(({ doi }) => doi)).size !== 1) return [];
		for (const match of matches) unused.delete(match);
		return [{ ...citation, doi: matches[0]!.doi }];
	});
}
