import { z } from 'zod';
import { normalizeDoi } from '../shared/paper-identity.ts';

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
	title: z.array(z.string()).min(1).max(10).nullish(),
});

const CrossrefResponseSchema = z.object({
	message: z.object({ items: z.array(CrossrefWorkSchema).max(CROSSREF_ROWS) }),
	status: z.literal('ok'),
});

type CrossrefWork = z.infer<typeof CrossrefWorkSchema>;

type CrossrefReferenceResolution = Readonly<{
	authors: string[];
	doi: string;
	title: string;
	url: string;
	venue: string | null;
	year: number | null;
}>;

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

function citationYears(value: string): Set<number> {
	return new Set([...value.matchAll(/\b(?:18|19|20|21)\d{2}\b/g)].map(([year]) => Number(year)).filter((year) => Number.isInteger(year)));
}

function publishedYear(work: CrossrefWork): number | null {
	const year = work.published?.['date-parts'][0]?.[0];
	return typeof year === 'number' && Number.isInteger(year) && year >= 1800 && year <= 2199 ? year : null;
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

	const years = citationYears(citation);
	const year = publishedYear(work);
	if (years.size && year !== null && !years.has(year)) return false;

	const familyNames = normalizedFamilyNames(work);
	const authorMatches = familyNames.some((family) => citationText.includes(family));
	if (!exactTitle && !authorMatches) return false;
	if (titleTokens.length < 5 && !authorMatches && !(year !== null && years.has(year))) return false;
	return true;
}

/** Select only a Crossref hit whose deposited metadata strongly agrees with the citation. */
export function selectCrossrefReference(citation: string, rawResponse: unknown): CrossrefReferenceResolution | null {
	const response = CrossrefResponseSchema.parse(rawResponse);
	for (const work of response.message.items) {
		if (!workMatchesCitation(citation, work)) continue;
		const doi = normalizeDoi(work.DOI);
		const title = boundedMetadata(work.title?.[0], MAX_TITLE_CHARS);
		if (doi && title) {
			return {
				authors: workAuthors(work),
				doi,
				title,
				url: `https://doi.org/${doi}`,
				venue: boundedMetadata(work['container-title']?.[0], MAX_VENUE_CHARS),
				year: publishedYear(work),
			};
		}
	}
	return null;
}

async function boundedJson(response: Response): Promise<unknown> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_CROSSREF_RESPONSE_BYTES) {
		await response.body?.cancel('Crossref response exceeded byte limit');
		throw new Error(`Crossref response exceeded ${MAX_CROSSREF_RESPONSE_BYTES} bytes`);
	}
	if (!response.body) throw new Error('Crossref response had no body');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let byteLength = 0;
	let json = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		byteLength += value.byteLength;
		if (byteLength > MAX_CROSSREF_RESPONSE_BYTES) {
			await reader.cancel('Crossref response exceeded byte limit');
			throw new Error(`Crossref response exceeded ${MAX_CROSSREF_RESPONSE_BYTES} bytes`);
		}
		json += decoder.decode(value, { stream: true });
	}
	return JSON.parse(json + decoder.decode());
}

export async function resolveCrossrefReference(citation: string): Promise<CrossrefReferenceResolution | null> {
	const query = citation.trim();
	if (!query || query.length > MAX_CITATION_CHARS) throw new TypeError(`Crossref citation must contain 1-${MAX_CITATION_CHARS} characters`);
	const url = new URL(CROSSREF_WORKS_URL);
	url.searchParams.set('mailto', CROSSREF_CONTACT);
	url.searchParams.set('query.bibliographic', query);
	url.searchParams.set('rows', String(CROSSREF_ROWS));
	url.searchParams.set('select', 'DOI,title,author,published,container-title');
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
	return selectCrossrefReference(query, await boundedJson(response));
}
