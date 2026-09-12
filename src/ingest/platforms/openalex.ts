import { z } from 'zod';
import {
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	normalizePaperIdentifiers,
	type PaperIdentifier,
	type PaperIdentity,
	paperIdentityFromIdentifiers,
} from '../../shared/paper-identity';

const OPENALEX_BASE = 'https://api.openalex.org';
const OPENALEX_CONTENT_HOST = 'content.openalex.org';
const REQUEST_TIMEOUT_MS = 8_000;
const CONTENT_REQUEST_TIMEOUT_MS = 90_000;

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
	publication_year: z.int().nullish(),
	publication_date: z.string().nullish(),
	cited_by_count: z.int().nonnegative().nullish(),
	referenced_works_count: z.int().nonnegative().nullish(),
	authorships: z.array(z.object({ author: z.object({ display_name: z.string().nullish() }) })).nullish(),
	abstract_inverted_index: z.record(z.string(), z.array(z.int().nonnegative())).nullish(),
	primary_location: OpenAlexLocationSchema.nullish(),
	best_oa_location: OpenAlexLocationSchema.nullish(),
	locations: z.array(OpenAlexLocationSchema).nullish(),
	has_content: z.object({ pdf: z.boolean() }).nullish(),
	content_urls: z.object({ pdf: z.string().nullish() }).nullish(),
});
const WORK_FIELDS = Object.keys(OpenAlexWorkSchema.shape).join(',');

type OpenAlexWork = z.infer<typeof OpenAlexWorkSchema>;

function httpsUrl(value: string | null | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	const url = URL.parse(value);
	return url?.protocol === 'https:' ? url.toString() : undefined;
}

function licensedPdfUrl(work: OpenAlexWork): string | null {
	const locations = [work.best_oa_location, work.primary_location, ...(work.locations ?? [])];
	for (const location of locations) {
		const pdfUrl = location?.is_oa === true && location.license?.trim() ? httpsUrl(location.pdf_url) : undefined;
		if (pdfUrl) return pdfUrl;
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

function openAlexContentPdfUrl(input: {
	hasContent: boolean;
	openAlexId: string | null | undefined;
	value: string | null | undefined;
}): string | null {
	if (!input.openAlexId || !input.hasContent) return null;
	const value = httpsUrl(input.value);
	if (!value) return null;
	const url = new URL(value);
	if (
		url.hostname !== OPENALEX_CONTENT_HOST ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== `/works/${input.openAlexId}.pdf`
	) {
		return null;
	}
	return url.toString();
}

function resolvedWorkIdentifiers(work: OpenAlexWork, inputIdentifiers: readonly PaperIdentifier[]): PaperIdentifier[] {
	const identity = paperIdentityFromIdentifiers(inputIdentifiers);
	const arxivId = arxivIdFromWork(work, identity);
	const providerDoi = normalizeDoi(work.doi);
	const arxivProxyDoi = arxivId ? normalizeDoi(`10.48550/arxiv.${arxivId}`) : null;
	const doi = providerDoi === arxivProxyDoi ? identity?.doi : (providerDoi ?? identity?.doi);
	const openAlexId = normalizeOpenAlexId(work.id);
	return normalizePaperIdentifiers([
		...(doi && doi !== arxivProxyDoi ? [{ preferred: true, scheme: 'doi' as const, value: doi }] : []),
		...(arxivId ? [{ preferred: true, scheme: 'arxiv' as const, value: arxivId }] : []),
		...(openAlexId ? [{ preferred: true, scheme: 'openalex' as const, value: openAlexId }] : []),
		...inputIdentifiers
			.filter((identifier) => identifier.scheme !== 'doi' || identifier.value !== arxivProxyDoi)
			.map((identifier) => ({ ...identifier, preferred: false })),
	]);
}

function normalizeOpenAlexWork(work: OpenAlexWork, inputIdentifiers: readonly PaperIdentifier[]) {
	const pdfUrl = licensedPdfUrl(work);
	const identifiers = resolvedWorkIdentifiers(work, inputIdentifiers);
	const identity = paperIdentityFromIdentifiers(identifiers);
	const openAlexId = identity?.openAlexId;
	const abstract =
		Object.entries(work.abstract_inverted_index ?? {})
			.flatMap(([word, positions]) => positions.map((position) => ({ position, word })))
			.sort((left, right) => left.position - right.position)
			.map(({ word }) => word)
			.join(' ')
			.trim() || undefined;
	return {
		contentPdfUrl: openAlexContentPdfUrl({
			hasContent: work.has_content?.pdf === true,
			openAlexId,
			value: work.content_urls?.pdf,
		}),
		identifiers,
		metadata: {
			title: work.title ?? undefined,
			authors: work.authorships?.map(({ author }) => author.display_name?.trim()).filter((name): name is string => !!name) ?? [],
			abstract,
			venue: work.primary_location?.source?.display_name?.trim() || work.best_oa_location?.source?.display_name?.trim() || undefined,
			year: work.publication_year ?? undefined,
			publicationDate: work.publication_date ?? undefined,
			citedByCount: work.cited_by_count ?? undefined,
			referenceCount: work.referenced_works_count ?? undefined,
			...(pdfUrl ? { pdfUrl } : {}),
		},
	};
}

async function fetchOpenAlexJson(path: string, apiKey: string): Promise<unknown | null> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const response = await fetch(`${OPENALEX_BASE}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (response.ok) {
		return response.json();
	}
	const retryAfter = response.headers.get('retry-after');
	await response.body?.cancel();
	if (response.status === 404) return null;
	throw new Error(`OpenAlex request failed with HTTP ${response.status}${retryAfter ? `; retry_after_seconds=${retryAfter}` : ''}`);
}

export async function resolveOpenAlexPaper(input: { apiKey?: string; identifiers: readonly PaperIdentifier[] }) {
	const apiKey = input.apiKey?.trim();
	if (!apiKey) return null;
	const identifiers = normalizePaperIdentifiers(input.identifiers);
	const identity = paperIdentityFromIdentifiers(identifiers);
	const doi = identity?.doi ?? (identity?.arxivId ? `10.48550/arxiv.${identity.arxivId}` : null);
	const workId = doi ? `https://doi.org/${encodeURIComponent(doi)}` : identity?.openAlexId ? encodeURIComponent(identity.openAlexId) : null;
	if (!workId) return null;
	const json = await fetchOpenAlexJson(`/works/${workId}?select=${WORK_FIELDS}`, apiKey);
	if (!json) return null;
	const work = OpenAlexWorkSchema.parse(json);
	return normalizeOpenAlexWork(work, identifiers);
}

export async function fetchOpenAlexPdf(input: { apiKey?: string; contentPdfUrl: string }): Promise<Response> {
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
	contentUrl.searchParams.set('api_key', apiKey);
	const response = await fetch(contentUrl, {
		headers: { Accept: 'application/pdf' },
		signal: AbortSignal.timeout(CONTENT_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`OpenAlex content PDF request failed with HTTP ${response.status}`);
	}
	return response;
}
