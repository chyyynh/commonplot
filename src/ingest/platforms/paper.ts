import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import {
	canonicalPaperUrl,
	isPaperIdentifierScheme,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	mergePaperIdentifiers,
	type PaperIdentifier,
	paperIdentityFromIdentifiers,
	samePaperTitle,
} from '../../shared/paper-identity';
import type { ResourceIdentifier } from '../../shared/resource';
import { readBoundedResponseText } from '../../shared/response';
import type { AcquiredResource } from '../acquisition';
import { storePublicPdfResponse } from '../zotero-sdt-service.ts';
import { stageArxivHtmlAcquisition } from './arxiv-html';
import { stagePublicPdfAcquisition } from './pdf';

const PAPER_METADATA_STEP = { retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;

const OPENALEX_BASE = 'https://api.openalex.org';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_OPENALEX_RESPONSE_BYTES = 8 * 1024 * 1024;
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

function licensedPdfUrl(work: OpenAlexWork): string | null {
	const locations = [work.best_oa_location, work.primary_location, ...(work.locations ?? [])];
	for (const location of locations) {
		const url = location?.is_oa === true && location.license?.trim() ? URL.parse(location.pdf_url ?? '') : null;
		if (url?.protocol === 'https:' && !url.username && !url.password) return url.toString();
	}
	return null;
}

function resolvedWorkIdentifiers(work: OpenAlexWork, inputIdentifiers: readonly PaperIdentifier[]): PaperIdentifier[] {
	const identity = paperIdentityFromIdentifiers(inputIdentifiers);
	let arxivId = identity?.arxivId ?? normalizeArxivId(work.doi);
	if (!arxivId) {
		for (const location of work.locations ?? []) {
			arxivId = normalizeArxivId(location.landing_page_url) ?? normalizeArxivId(location.pdf_url);
			if (arxivId) break;
		}
	}
	const providerDoi = normalizeDoi(work.doi);
	const arxivProxyDoi = arxivId ? `10.48550/arxiv.${arxivId}` : null;
	const doi = providerDoi === arxivProxyDoi ? identity?.doi : (providerDoi ?? identity?.doi);
	const openAlexId = normalizeOpenAlexId(work.id);
	return mergePaperIdentifiers([
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
	const contentUrl = work.has_content?.pdf === true ? URL.parse(work.content_urls?.pdf ?? '') : null;
	// Only the exact content endpoint may receive our API key.
	const contentPdfUrl =
		openAlexId &&
		contentUrl?.origin === 'https://content.openalex.org' &&
		!contentUrl.username &&
		!contentUrl.password &&
		!contentUrl.search &&
		!contentUrl.hash &&
		contentUrl.pathname === `/works/${openAlexId}.pdf`
			? contentUrl.toString()
			: null;
	const abstract =
		Object.entries(work.abstract_inverted_index ?? {})
			.flatMap(([word, positions]) => positions.map((position) => ({ position, word })))
			.sort((left, right) => left.position - right.position)
			.map(({ word }) => word)
			.join(' ')
			.trim() || undefined;
	return {
		contentPdfUrl,
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

async function resolveOpenAlexPaper(input: { apiKey?: string; identifiers: readonly PaperIdentifier[] }) {
	const apiKey = input.apiKey?.trim();
	if (!apiKey) throw new NonRetryableError('OPENALEX_API_KEY is not configured');
	const identity = paperIdentityFromIdentifiers(input.identifiers);
	const doi = identity?.doi ?? (identity?.arxivId ? `10.48550/arxiv.${identity.arxivId}` : null);
	const workId = doi ? `https://doi.org/${encodeURIComponent(doi)}` : identity?.openAlexId ? encodeURIComponent(identity.openAlexId) : null;
	if (!workId) return null;
	const response = await fetch(`${OPENALEX_BASE}/works/${workId}?select=${WORK_FIELDS}`, {
		headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const retryAfter = response.headers.get('retry-after');
		await response.body?.cancel();
		if (response.status === 404) return null;
		const ErrorType = [400, 401, 403, 410, 422].includes(response.status) ? NonRetryableError : Error;
		throw new ErrorType(`OpenAlex request failed with HTTP ${response.status}${retryAfter ? `; retry_after_seconds=${retryAfter}` : ''}`);
	}
	const work = OpenAlexWorkSchema.parse(
		JSON.parse(await readBoundedResponseText(response, MAX_OPENALEX_RESPONSE_BYTES, 'OpenAlex response')),
	);
	return normalizeOpenAlexWork(work, input.identifiers);
}

/** Alternate paper PDFs share acquisition; key-bearing OpenAlex content stays local-only. */
async function stagePaperPdfContent(
	env: CoreEnv,
	step: WorkflowStep,
	input: { contentPdfUrl: string | null; publicPdfUrl: string | null; processingId: string },
) {
	for (const [provider, url] of [
		['openalex', input.contentPdfUrl],
		['open-access', input.publicPdfUrl],
	] as const) {
		if (!url || (provider === 'open-access' && url === input.contentPdfUrl)) continue;
		try {
			const source = await step.do(
				`download-paper-${provider}-pdf-v1`,
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				async () => {
					const requestUrl = new URL(url);
					if (provider === 'openalex') {
						const apiKey = env.OPENALEX_API_KEY?.trim();
						if (!apiKey) throw new Error('OpenAlex content download requires an API key');
						requestUrl.searchParams.set('api_key', apiKey);
					}
					const response = await fetch(requestUrl, {
						headers: { Accept: 'application/pdf' },
						signal: AbortSignal.timeout(CONTENT_REQUEST_TIMEOUT_MS),
					});
					if (!response.ok) {
						await response.body?.cancel();
						const ErrorType = [400, 401, 403, 404, 410, 422].includes(response.status) ? NonRetryableError : Error;
						throw new ErrorType(`Paper PDF request failed (${provider}) with HTTP ${response.status}`);
					}
					return storePublicPdfResponse(env, response, url);
				},
			);
			const resource = await stagePublicPdfAcquisition(env, step, { source, grant: null, processingId: input.processingId });
			console.info({
				tag: 'PAPER_CONTENT',
				event: 'pdf_acquired',
				provider,
				processing_id: input.processingId,
				chars: resource.content.length,
			});
			return resource;
		} catch (error) {
			console.error({
				tag: 'PAPER_CONTENT',
				event: 'pdf_acquisition_failed',
				provider,
				processing_id: input.processingId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}

export type PaperMetadata = NonNullable<Awaited<ReturnType<typeof resolveOpenAlexPaper>>>;

/**
 * OpenAlex describes every paper. Identifiers read from a PDF only count when the
 * title printed on that PDF names the resolved work; `printedTitle` is omitted for
 * identifiers taken from the link itself.
 */
export async function stagePaperMetadata(
	env: CoreEnv,
	step: WorkflowStep,
	input: { identifiers: readonly ResourceIdentifier[]; printedTitle?: string | null; processingId: string },
): Promise<PaperMetadata | null> {
	const identifiers = mergePaperIdentifiers(
		input.identifiers.filter((identifier): identifier is PaperIdentifier => isPaperIdentifierScheme(identifier.scheme)),
	);
	if (!identifiers.length) return null;
	const startedAt = Date.now();
	const stream = await step.do(
		'resolve-paper-openalex-v6',
		PAPER_METADATA_STEP,
		async () => Response.json(await resolveOpenAlexPaper({ apiKey: env.OPENALEX_API_KEY, identifiers })).body!,
	);
	const work = await new Response(stream).json<PaperMetadata | null>();
	const verified =
		!work ||
		input.printedTitle === undefined ||
		(!!input.printedTitle && !!work.metadata.title && samePaperTitle(input.printedTitle, work.metadata.title));
	console.info({
		tag: 'PAPER_PROVIDER',
		event: 'paper_metadata',
		provider: 'openalex',
		processing_id: input.processingId,
		outcome: !work ? 'not_found' : verified ? 'resolved' : 'title_mismatch',
		latency_ms: Date.now() - startedAt,
	});
	return verified ? work : null;
}

/** Readable full text, best source first: arXiv's HTML, then a licensed PDF; null leaves the paper with its abstract. */
export async function stagePaperFullText(env: CoreEnv, step: WorkflowStep, input: { work: PaperMetadata; processingId: string }) {
	const arxivId = paperIdentityFromIdentifiers(input.work.identifiers)?.arxivId;
	if (arxivId) {
		try {
			const html = await stageArxivHtmlAcquisition(step, arxivId);
			if (html) return html;
		} catch (error) {
			console.error({
				tag: 'PAPER_CONTENT',
				event: 'arxiv_html_failed',
				processing_id: input.processingId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return stagePaperPdfContent(env, step, {
		contentPdfUrl: input.work.contentPdfUrl,
		publicPdfUrl: input.work.metadata.pdfUrl ?? null,
		processingId: input.processingId,
	});
}

/** The abstract stands in for the body when no licensed full text exists. */
export function paperAbstractDocument(work: PaperMetadata): (AcquiredResource & { resourcePlatform: null }) | null {
	const abstract = work.metadata.abstract?.trim();
	const identity = paperIdentityFromIdentifiers(work.identifiers);
	if (!abstract || !identity) return null;
	const url = canonicalPaperUrl(identity);
	return {
		kind: 'paper',
		resourcePlatform: null,
		resourceIdentifiers: work.identifiers,
		url,
		fileType: null,
		title: work.metadata.title ?? null,
		summary: abstract,
		content: abstract,
		source: new URL(url).hostname,
		originalLang: 'und',
		publishedDate: null,
		creators: [],
		kindMetadata: {},
		previewImageUrl: null,
		subjectUrl: null,
	};
}

/**
 * Describe the document that carries a paper's readable text with the paper's identity and
 * metadata. Without resolved metadata only `identifiers` the caller trusts name the paper.
 */
export function paperResource(
	document: AcquiredResource,
	work: PaperMetadata | null,
	identifiers: readonly ResourceIdentifier[] = [],
): AcquiredResource & { kind: 'paper'; resourcePlatform: null } {
	const resourceIdentifiers =
		work?.identifiers ??
		mergePaperIdentifiers(identifiers.filter((identifier): identifier is PaperIdentifier => isPaperIdentifierScheme(identifier.scheme)));
	const identity = paperIdentityFromIdentifiers(resourceIdentifiers);
	if (!identity) throw new TypeError('A paper requires a DOI, arXiv, or OpenAlex identifier');
	const { abstract, authors, publicationDate, title, ...kindMetadata } = work?.metadata ?? {};
	let publishedDate = document.publishedDate;
	if (!publishedDate && publicationDate) {
		const date = new Date(`${publicationDate}T00:00:00.000Z`);
		if (!Number.isNaN(date.getTime())) publishedDate = date.toISOString();
	}
	const { printedTitle: _printedTitle, ...rest } = document;
	return {
		...rest,
		kind: 'paper',
		resourcePlatform: null,
		resourceIdentifiers,
		url: document.url ?? canonicalPaperUrl(identity),
		title: title?.trim() || document.title,
		summary: abstract?.trim() || document.summary,
		publishedDate,
		creators: authors?.length ? authors.map((literal) => ({ role: 'author', literal })) : document.creators,
		kindMetadata,
	};
}
