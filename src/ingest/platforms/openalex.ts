import {
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	normalizePaperIdentifiers,
	type PaperIdentifier,
	type PaperIdentity,
	paperIdentityFromIdentifiers,
} from '@core-shared/paper-identity';
import type { PaperRelationItem, PaperRelationSnapshot } from '@core-shared/resource';
import { z } from 'zod';
import { markdownFromXml } from '../document-conversion';
import type { AcquiredMaterial } from './materialize';
import { acquireFetchedPdfResponse } from './pdf';

export interface PaperMetadata {
	title?: string;
	authors: string[];
	abstract?: string;
	venue?: string;
	year?: number;
	publicationDate?: string;
	citedByCount?: number;
	referenceCount?: number;
	pdfUrl?: string;
	references?: PaperRelationSnapshot;
	citations?: PaperRelationSnapshot;
}

const OPENALEX_BASE = 'https://api.openalex.org';
const OPENALEX_CONTENT_HOST = 'content.openalex.org';
const REQUEST_TIMEOUT_MS = 8_000;
const CONTENT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RELATION_ITEMS = 100;
const WORK_FIELDS = [
	'id',
	'doi',
	'title',
	'publication_year',
	'publication_date',
	'cited_by_count',
	'referenced_works_count',
	'referenced_works',
	'authorships',
	'abstract_inverted_index',
	'primary_location',
	'best_oa_location',
	'locations',
	'has_content',
	'content_urls',
].join(',');
const RELATION_WORK_FIELDS = ['id', 'doi', 'title', 'publication_year', 'cited_by_count', 'authorships', 'primary_location'].join(',');

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
	referenced_works: z.array(z.string()).nullish(),
	authorships: z.array(z.object({ author: z.object({ display_name: z.string().nullish() }) })).nullish(),
	abstract_inverted_index: z.record(z.string(), z.array(z.number().int().nonnegative())).nullish(),
	primary_location: OpenAlexLocationSchema.nullish(),
	best_oa_location: OpenAlexLocationSchema.nullish(),
	locations: z.array(OpenAlexLocationSchema).nullish(),
	has_content: z.object({ pdf: z.boolean(), grobid_xml: z.boolean() }).nullish(),
	content_urls: z.object({ pdf: z.string().nullish(), grobid_xml: z.string().nullish() }).nullish(),
});

const OpenAlexListSchema = z.object({
	meta: z.object({ count: z.number().int().nonnegative() }).passthrough(),
	results: z.array(OpenAlexWorkSchema),
});

type OpenAlexWork = z.infer<typeof OpenAlexWorkSchema>;

type OpenAlexPaperResolution = Readonly<{
	contentGrobidXmlUrl: string | null;
	contentPdfUrl: string | null;
	identifiers: PaperIdentifier[];
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

function openAlexContentUrl(input: {
	extension: 'pdf' | 'grobid-xml';
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
		url.pathname !== `/works/${input.openAlexId}.${input.extension}`
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

function normalizeRelationItem(work: OpenAlexWork): PaperRelationItem | null {
	const openAlexId = normalizeOpenAlexId(work.id);
	const title = work.title?.trim();
	if (!openAlexId || !title) return null;
	const doi = normalizeDoi(work.doi);
	return {
		openAlexId,
		...(doi ? { doi } : {}),
		title,
		authors: work.authorships?.map(({ author }) => author.display_name?.trim()).filter((name): name is string => !!name) ?? [],
		venue: work.primary_location?.source?.display_name?.trim() || undefined,
		year: work.publication_year ?? undefined,
		citedByCount: work.cited_by_count ?? undefined,
	};
}

function relationSnapshot(input: { items: OpenAlexWork[]; total: number }): PaperRelationSnapshot {
	const items = input.items.flatMap((work) => {
		const normalized = normalizeRelationItem(work);
		return normalized ? [normalized] : [];
	});
	return {
		items,
		total: input.total,
	};
}

function normalizeOpenAlexWork(
	work: OpenAlexWork,
	inputIdentifiers: readonly PaperIdentifier[],
	relations?: { citations: PaperRelationSnapshot; references: PaperRelationSnapshot },
): OpenAlexPaperResolution {
	const pdfUrl = licensedPdfUrl(work);
	const identifiers = resolvedWorkIdentifiers(work, inputIdentifiers);
	const identity = paperIdentityFromIdentifiers(identifiers);
	const openAlexId = identity?.openAlexId;
	const referenceCount = work.referenced_works_count ?? undefined;
	return {
		contentGrobidXmlUrl: openAlexContentUrl({
			extension: 'grobid-xml',
			hasContent: work.has_content?.grobid_xml === true,
			openAlexId,
			value: work.content_urls?.grobid_xml,
		}),
		contentPdfUrl: openAlexContentUrl({
			extension: 'pdf',
			hasContent: work.has_content?.pdf === true,
			openAlexId,
			value: work.content_urls?.pdf,
		}),
		identifiers,
		metadata: {
			title: work.title ?? undefined,
			authors: work.authorships?.map(({ author }) => author.display_name?.trim()).filter((name): name is string => !!name) ?? [],
			abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
			venue: work.primary_location?.source?.display_name?.trim() || work.best_oa_location?.source?.display_name?.trim() || undefined,
			year: work.publication_year ?? undefined,
			publicationDate: work.publication_date ?? undefined,
			citedByCount: work.cited_by_count ?? undefined,
			referenceCount,
			...(pdfUrl ? { pdfUrl } : {}),
			...(relations ? { citations: relations.citations, references: relations.references } : {}),
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
	const status = response.status;
	const retryAfter = response.headers.get('retry-after');
	await response.body?.cancel();
	if (status === 404) return null;
	throw new Error(`OpenAlex request failed with HTTP ${status}${retryAfter ? `; retry_after_seconds=${retryAfter}` : ''}`);
}

function workLookupPath(identifiers: readonly PaperIdentifier[]): string | null {
	const identity = paperIdentityFromIdentifiers(identifiers);
	if (!identity) return null;
	let workId: string | null = null;
	const doi = identity.doi ?? (identity.arxivId ? `10.48550/arxiv.${identity.arxivId}` : null);
	if (doi) workId = `https://doi.org/${encodeURIComponent(doi)}`;
	else if (identity.openAlexId) workId = encodeURIComponent(identity.openAlexId);
	return workId ? `/works/${workId}?select=${WORK_FIELDS}` : null;
}

function worksListPath(params: Record<string, string>): string {
	return `/works?${new URLSearchParams(params).toString()}`;
}

async function fetchOpenAlexRelations(input: {
	apiKey: string;
	work: OpenAlexWork;
}): Promise<{ citations: PaperRelationSnapshot; references: PaperRelationSnapshot }> {
	const openAlexId = normalizeOpenAlexId(input.work.id);
	if (!openAlexId) throw new Error('OpenAlex work response has no valid id');
	const referencedIds = (input.work.referenced_works ?? [])
		.map(normalizeOpenAlexId)
		.filter((value): value is string => !!value)
		.slice(0, MAX_RELATION_ITEMS);
	const referenceRequest = referencedIds.length
		? fetchOpenAlexJson(
				worksListPath({
					filter: `openalex_id:${referencedIds.join('|')}`,
					'per-page': String(referencedIds.length),
					select: RELATION_WORK_FIELDS,
					sort: 'cited_by_count:desc',
				}),
				input.apiKey,
			)
		: Promise.resolve({ meta: { count: 0 }, results: [] });
	const citationRequest = fetchOpenAlexJson(
		worksListPath({
			filter: `cites:${openAlexId}`,
			'per-page': String(MAX_RELATION_ITEMS),
			select: RELATION_WORK_FIELDS,
			sort: 'cited_by_count:desc',
		}),
		input.apiKey,
	);
	const [referenceJson, citationJson] = await Promise.all([referenceRequest, citationRequest]);
	const references = OpenAlexListSchema.parse(referenceJson);
	const citations = OpenAlexListSchema.parse(citationJson);
	return {
		citations: relationSnapshot({ items: citations.results, total: citations.meta.count }),
		references: relationSnapshot({
			items: references.results,
			total: input.work.referenced_works_count ?? references.meta.count,
		}),
	};
}

export async function resolveOpenAlexPaper(input: {
	apiKey?: string;
	identifiers: readonly PaperIdentifier[];
}): Promise<OpenAlexPaperResolution | null> {
	const apiKey = input.apiKey?.trim();
	if (!apiKey) return null;
	const identifiers = normalizePaperIdentifiers(input.identifiers);
	const lookupPath = workLookupPath(identifiers);
	if (!lookupPath) return null;
	const json = await fetchOpenAlexJson(lookupPath, apiKey);
	if (!json) return null;
	const work = OpenAlexWorkSchema.parse(json);
	const relations = await fetchOpenAlexRelations({ apiKey, work });
	return normalizeOpenAlexWork(work, identifiers, relations);
}

export async function acquireOpenAlexPdf(input: { apiKey?: string; contentPdfUrl: string }): Promise<AcquiredMaterial<null>> {
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
	const response = await fetch(requestUrl, {
		headers: { Accept: 'application/pdf' },
		signal: AbortSignal.timeout(CONTENT_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`OpenAlex content PDF request failed with HTTP ${status}`);
	}
	return acquireFetchedPdfResponse(response, contentUrl.toString());
}

export async function acquireOpenAlexGrobidText(input: {
	contentGrobidXmlUrl: string;
	env: CoreEnv;
	processingId?: string;
}): Promise<string> {
	const apiKey = input.env.OPENALEX_API_KEY?.trim();
	if (!apiKey) throw new Error('OpenAlex content download requires an API key');
	const contentUrl = new URL(input.contentGrobidXmlUrl);
	if (
		contentUrl.protocol !== 'https:' ||
		contentUrl.hostname !== OPENALEX_CONTENT_HOST ||
		contentUrl.username ||
		contentUrl.password ||
		contentUrl.search ||
		contentUrl.hash ||
		!contentUrl.pathname.endsWith('.grobid-xml')
	) {
		throw new Error('OpenAlex content GROBID XML URL is invalid');
	}
	const requestUrl = new URL(contentUrl);
	requestUrl.searchParams.set('api_key', apiKey);
	const response = await fetch(requestUrl, {
		headers: { Accept: 'application/xml,text/xml' },
		signal: AbortSignal.timeout(CONTENT_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`OpenAlex content GROBID XML request failed with HTTP ${status}`);
	}
	return markdownFromXml(input.env, await response.text(), input.processingId);
}
