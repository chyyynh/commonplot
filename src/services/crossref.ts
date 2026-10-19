import { z } from 'zod';
import { canonicalPaperUrl, normalizeBibliographicText, normalizeDoi } from '../contracts/paper-identity.ts';
import { CRAWLER_CONTACT, crawlerUserAgent } from './crawler-identity.ts';
import { fetchOk, readBoundedResponseText } from './response.ts';

const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const CROSSREF_USER_AGENT = crawlerUserAgent();
const CROSSREF_TIMEOUT_MS = 12_000;
const MAX_CITATION_QUERY_CHARS = 600;
const MAX_CROSSREF_SEARCH_BYTES = 256 * 1024;
const MAX_CROSSREF_WORK_BYTES = 8 * 1024 * 1024;
const CROSSREF_ROWS = 3;

// Some agencies (Airiti) give date parts as strings.
const DateSchema = z.object({ 'date-parts': z.array(z.array(z.coerce.number()).min(1).max(3)).min(1).max(3) }).nullish();
/** A Crossref work, or the CSL JSON doi.org answers with, which gives single strings where Crossref gives lists. */
const CrossrefWorkSchema = z.object({
	DOI: z.string(),
	author: z
		.array(
			z.object({ family: z.string().nullish(), given: z.string().nullish(), name: z.string().nullish(), literal: z.string().nullish() }),
		)
		.nullish(),
	published: DateSchema,
	issued: DateSchema,
	title: z.union([z.string(), z.array(z.string()).max(10)]).nullish(),
	'container-title': z.union([z.string(), z.array(z.string()).max(10)]).nullish(),
});

const CrossrefResponseSchema = z.object({
	message: z.object({ items: z.array(CrossrefWorkSchema).max(CROSSREF_ROWS) }),
	status: z.literal('ok'),
});

type CrossrefWork = z.infer<typeof CrossrefWorkSchema>;

const first = (value: string | string[] | null | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || null;

/** A work a PDF may be: what Jev is shown to pick from, and what a picked paper falls back to when OpenAlex has no record. */
export type WorkCandidate = NonNullable<ReturnType<typeof workCandidate>>;

function workCandidate(work: CrossrefWork) {
	const doi = normalizeDoi(work.DOI);
	const title = first(work.title);
	if (!doi || !title) return null;
	const authors = (work.author ?? [])
		.map((author) => (author.literal || author.name || [author.given, author.family].filter(Boolean).join(' ')).trim())
		.filter(Boolean)
		.slice(0, 8);
	return { doi, title, authors, year: publishedYear(work), venue: first(work['container-title']) };
}

function significantTokens(value: string): string[] {
	return [...new Set(value.split(' ').filter((token) => token.length >= 3))];
}

function publishedYear(work: CrossrefWork): number | null {
	const year = (work.published ?? work.issued)?.['date-parts'][0]?.[0];
	return typeof year === 'number' && Number.isInteger(year) && year >= 1800 && year <= 2199 ? year : null;
}

function workMatchesCitation(citation: string, work: CrossrefWork): boolean {
	const citationText = normalizeBibliographicText(citation);
	const titleText = normalizeBibliographicText(first(work.title) ?? '');
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

	const authorMatches = (work.author ?? [])
		.slice(0, 3)
		.map(({ family, name }) => normalizeBibliographicText(family?.trim() || name || ''))
		.some((name) => name.length >= 3 && ` ${citationText} `.includes(` ${name} `));
	if (!exactTitle && !authorMatches) return false;
	if (titleTokens.length < 5 && !authorMatches && !(year !== null && years.has(year))) return false;
	return true;
}

async function fetchCrossref(params: Readonly<Record<string, string>>, doi?: string): Promise<unknown> {
	const url = new URL(doi ? `${CROSSREF_WORKS_URL}/${encodeURIComponent(doi)}` : CROSSREF_WORKS_URL);
	url.search = new URLSearchParams({ mailto: CRAWLER_CONTACT, ...params }).toString();
	const response = await fetchOk(url, {
		label: 'Crossref request',
		timeoutMs: CROSSREF_TIMEOUT_MS,
		permanent: [400, 401, 403, 404, 410, 422],
		missing: doi ? [404] : [],
		headers: { Accept: 'application/json', 'User-Agent': CROSSREF_USER_AGENT },
	});
	if (!response) return null;
	return JSON.parse(
		await readBoundedResponseText(response, doi ? MAX_CROSSREF_WORK_BYTES : MAX_CROSSREF_SEARCH_BYTES, 'Crossref response'),
	);
}

/** Crossref's best matches for a citation or a title. */
async function searchCrossref(query: string) {
	const response = await fetchCrossref({
		'query.bibliographic': query.slice(0, MAX_CITATION_QUERY_CHARS),
		rows: String(CROSSREF_ROWS),
		select: 'DOI,title,author,published,container-title',
	});
	return CrossrefResponseSchema.parse(response).message.items;
}

/** A citation's DOI when exactly one of Crossref's matches is the cited work; a stored citation is never empty. */
export async function resolveCrossrefReferenceDoi(citation: string) {
	const query = citation.trim();
	const matches = (await searchCrossref(query)).filter((work) => workMatchesCitation(query, work));
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
	// `doi` is a stored, already normalized key.
	const response = await fetchCrossref({}, doi);
	if (response === null) return [];
	const { message } = CrossrefDepositedReferencesSchema.parse(response);
	if (normalizeDoi(message.DOI) !== doi) return [];
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

/** Crossref's best matches for the title a PDF prints. */
export async function searchCrossrefWorks(title: string): Promise<WorkCandidate[]> {
	return (await searchCrossref(title)).flatMap((work) => workCandidate(work) ?? []);
}

/** The work a DOI names, as its registration agency describes it: doi.org answers for Crossref, DataCite, Airiti and the rest. */
export async function lookupDoiWork(doi: string): Promise<WorkCandidate | null> {
	const response = await fetchOk(canonicalPaperUrl({ doi }), {
		label: 'doi.org request',
		timeoutMs: CROSSREF_TIMEOUT_MS,
		permanent: [400, 401, 403, 404, 406, 410],
		missing: [404],
		headers: { Accept: 'application/vnd.citationstyles.csl+json', 'User-Agent': CROSSREF_USER_AGENT },
	});
	if (!response) return null;
	const work = CrossrefWorkSchema.parse(JSON.parse(await readBoundedResponseText(response, MAX_CROSSREF_WORK_BYTES, 'doi.org response')));
	return workCandidate(work);
}
