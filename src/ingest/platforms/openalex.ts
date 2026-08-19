import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import { normalizeArxivId, normalizeDoi, normalizeOpenAlexId, type PaperIdentity } from '@core-shared/paper-identity';
import type { PaperMetadata } from '@core-shared/types';
import { z } from 'zod';
import { type AcquiredWebContent, acquireFetchedPdfResponse } from '../web-acquisition';

const OPENALEX_BASE = 'https://api.openalex.org';
const OPENALEX_CONTENT_HOST = 'content.openalex.org';
const REQUEST_TIMEOUT_MS = 8_000;
const CONTENT_REQUEST_TIMEOUT_MS = 120_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const WORK_FIELDS = [
	'id',
	'doi',
	'title',
	'publication_year',
	'publication_date',
	'cited_by_count',
	'referenced_works_count',
	'authorships',
	'abstract_inverted_index',
	'primary_location',
	'best_oa_location',
	'locations',
	'has_content',
	'content_urls',
].join(',');

const OpenAlexLocationSchema = z.object({
	is_oa: z.boolean().nullish(),
	landing_page_url: z.string().nullish(),
	license: z.string().nullish(),
	pdf_url: z.string().nullish(),
	source: z.object({ display_name: z.string().nullish() }).nullish(),
});

const OpenAlexWorkSchema = z.object({
	id: z.string(),
	doi: z.string().nullish(),
	title: z.string().nullish(),
	publication_year: z.number().int().nullish(),
	publication_date: z.string().nullish(),
	cited_by_count: z.number().int().nonnegative().nullish(),
	referenced_works_count: z.number().int().nonnegative().nullish(),
	authorships: z.array(z.object({ author: z.object({ display_name: z.string().nullish() }) })).nullish(),
	abstract_inverted_index: z.record(z.string(), z.array(z.number().int().nonnegative())).nullish(),
	primary_location: OpenAlexLocationSchema.nullish(),
	best_oa_location: OpenAlexLocationSchema.nullish(),
	locations: z.array(OpenAlexLocationSchema).nullish(),
	has_content: z.object({ pdf: z.boolean(), grobid_xml: z.boolean() }).nullish(),
	content_urls: z.object({ pdf: z.string().nullish(), grobid_xml: z.string().nullish() }).nullish(),
});

type OpenAlexLocation = z.infer<typeof OpenAlexLocationSchema>;
type OpenAlexWork = z.infer<typeof OpenAlexWorkSchema>;

export type OpenAlexPaperResolution = Readonly<{
	contentPdfUrl: string | null;
	metadata: PaperMetadata;
}>;

function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined): string | undefined {
	if (!index) return undefined;
	const words = Object.entries(index).flatMap(([word, positions]) => positions.map((position) => ({ position, word })));
	words.sort((left, right) => left.position - right.position);
	return (
		words
			.map(({ word }) => word)
			.join(' ')
			.trim() || undefined
	);
}

function httpsUrl(value: string | null | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function licensedPdfLocation(work: OpenAlexWork): (OpenAlexLocation & { license: string; pdf_url: string }) | null {
	const locations = [work.best_oa_location, work.primary_location, ...(work.locations ?? [])];
	for (const location of locations) {
		if (location?.is_oa === true && location.license?.trim() && httpsUrl(location.pdf_url)) {
			return {
				...location,
				license: location.license.trim(),
				pdf_url: httpsUrl(location.pdf_url) as string,
			};
		}
	}
	return null;
}

function arxivIdFromWork(work: OpenAlexWork, identity: PaperIdentity | null): string | undefined {
	if (identity?.arxivId) return identity.arxivId;
	const doi = normalizeDoi(work.doi);
	const fromDoi = doi?.startsWith('10.48550/arxiv.') ? normalizeArxivId(doi.slice('10.48550/arxiv.'.length)) : null;
	if (fromDoi) return fromDoi;
	for (const location of work.locations ?? []) {
		const arxivId = normalizeArxivId(location.landing_page_url) ?? normalizeArxivId(location.pdf_url);
		if (arxivId) return arxivId;
	}
	return undefined;
}

function openAlexContentPdfUrl(work: OpenAlexWork, openAlexId: string | null | undefined): string | null {
	if (!openAlexId || work.has_content?.pdf !== true) return null;
	const value = httpsUrl(work.content_urls?.pdf);
	if (!value) return null;
	const url = new URL(value);
	if (
		url.hostname !== OPENALEX_CONTENT_HOST ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== `/works/${openAlexId}.pdf`
	) {
		return null;
	}
	return url.toString();
}

function normalizeOpenAlexWork(work: OpenAlexWork, identity: PaperIdentity | null): OpenAlexPaperResolution {
	const fetchedAt = new Date().toISOString();
	const pdf = licensedPdfLocation(work);
	const arxivId = arxivIdFromWork(work, identity);
	const providerDoi = normalizeDoi(work.doi);
	// arXiv already has its own canonical identifier. Persisting the DataCite
	// proxy DOI as a second identity is redundant and can conflict with a
	// publisher DOI already attached to the same Resource.
	const arxivProxyDoi = arxivId ? normalizeDoi(`10.48550/arxiv.${arxivId}`) : null;
	const doi = identity?.doi ?? (providerDoi === arxivProxyDoi ? undefined : providerDoi);
	const openAlexId = normalizeOpenAlexId(work.id);
	const referenceCount = work.referenced_works_count ?? undefined;
	return {
		contentPdfUrl: openAlexContentPdfUrl(work, openAlexId),
		metadata: {
			schemaVersion: 2,
			source: 'openalex',
			resolvedAt: fetchedAt,
			metricsUpdatedAt: fetchedAt,
			...(doi ? { doi } : {}),
			...(arxivId ? { arxivId } : {}),
			...(openAlexId ? { openAlexId } : {}),
			title: work.title ?? undefined,
			authors: work.authorships?.map(({ author }) => author.display_name?.trim()).filter((name): name is string => !!name) ?? [],
			abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
			venue: work.primary_location?.source?.display_name?.trim() || work.best_oa_location?.source?.display_name?.trim() || undefined,
			year: work.publication_year ?? undefined,
			publicationDate: work.publication_date ?? undefined,
			citedByCount: work.cited_by_count ?? undefined,
			referenceCount,
			...(pdf ? { pdfUrl: pdf.pdf_url, pdfLicense: pdf.license } : {}),
		},
	};
}

async function fetchOpenAlexJson(path: string, apiKey: string): Promise<unknown | null> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const response = await fetchWithTimeout(`${OPENALEX_BASE}${path}`, { headers }, REQUEST_TIMEOUT_MS);
	if (response.ok) {
		return JSON.parse(await readTextWithLimit(response, RESPONSE_MAX_BYTES));
	}
	const status = response.status;
	const retryAfter = response.headers.get('retry-after');
	await response.body?.cancel();
	if (status === 404) return null;
	throw new Error(`OpenAlex request failed with HTTP ${status}${retryAfter ? `; retry_after_seconds=${retryAfter}` : ''}`);
}

function workLookupPath(identity: PaperIdentity): string | null {
	let workId: string | null = null;
	if (identity.openAlexId) {
		workId = encodeURIComponent(identity.openAlexId);
	} else {
		const doi = identity.doi ?? (identity.arxivId ? `10.48550/arxiv.${identity.arxivId}` : null);
		if (doi) workId = `https://doi.org/${encodeURIComponent(doi)}`;
	}
	return workId ? `/works/${workId}?select=${WORK_FIELDS}` : null;
}

export async function resolveOpenAlexPaper(input: { apiKey?: string; identity: PaperIdentity }): Promise<OpenAlexPaperResolution | null> {
	const apiKey = input.apiKey?.trim();
	if (!apiKey) return null;
	const lookupPath = workLookupPath(input.identity);
	if (!lookupPath) return null;
	const json = await fetchOpenAlexJson(lookupPath, apiKey);
	if (!json) return null;
	return normalizeOpenAlexWork(OpenAlexWorkSchema.parse(json), input.identity);
}

export async function acquireOpenAlexPdf(input: {
	apiKey?: string;
	contentPdfUrl: string;
	env: CoreEnv;
	resourceId: string;
}): Promise<AcquiredWebContent> {
	const apiKey = input.apiKey?.trim();
	if (!apiKey) throw new Error('OpenAlex content download requires an API key');
	const contentUrl = new URL(input.contentPdfUrl);
	if (
		contentUrl.protocol !== 'https:' ||
		contentUrl.hostname !== OPENALEX_CONTENT_HOST ||
		contentUrl.username ||
		contentUrl.password ||
		contentUrl.search ||
		contentUrl.hash
	) {
		throw new Error('OpenAlex content PDF URL is invalid');
	}
	const requestUrl = new URL(contentUrl);
	requestUrl.searchParams.set('api_key', apiKey);
	const response = await fetchWithTimeout(requestUrl.toString(), { headers: { Accept: 'application/pdf' } }, CONTENT_REQUEST_TIMEOUT_MS);
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`OpenAlex content PDF request failed with HTTP ${status}`);
	}
	return acquireFetchedPdfResponse(input.env, input.resourceId, response, contentUrl.toString());
}
