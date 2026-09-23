import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import {
	canonicalPaperUrl,
	isPaperIdentifierScheme,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	normalizePaperIdentifiers,
	type PaperIdentifier,
	type PaperIdentity,
	paperIdentifiersFromIdentity,
	paperIdentityFromIdentifiers,
} from '../../shared/paper-identity';
import { readBoundedResponseText } from '../../shared/response';
import type { AcquiredResource } from '../acquisition';
import { resolveCrossrefPaper, resolveCrossrefPaperCandidate } from '../crossref';
import { storePublicPdfResponse } from '../zotero-sdt-service.ts';
import { stagePublicPdfAcquisition } from './pdf';
import { PDF_MIME, type PaidPdfFallbackGrant } from './pdf-policy';
import type { ResolvedResourceUrl } from './resource-url';
import { stageWebAcquisition } from './web';

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
	if (!apiKey) return null;
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

type ParsedPaperInput = {
	resource: AcquiredResource & { resourcePlatform: null };
	/** Only a GROBID header may propose an uploaded PDF without an identifier. */
	candidate?: { title: string; authors: readonly string[] };
	processingId: string;
};

type PaperUrlInput = {
	url: string;
	paidPdfFallback: PaidPdfFallbackGrant | null;
	processingId: string;
	identifiers: AcquiredResource['resourceIdentifiers'];
};

export function stagePaperAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: ParsedPaperInput,
): Promise<AcquiredResource & { resourcePlatform: null }>;
export function stagePaperAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: PaperUrlInput,
): Promise<(AcquiredResource & { resourcePlatform: null }) | { platform: ResolvedResourceUrl }>;
export async function stagePaperAcquisition(env: CoreEnv, step: WorkflowStep, input: ParsedPaperInput | PaperUrlInput) {
	const parsed = 'resource' in input ? input.resource : null;
	const candidate = 'resource' in input ? input.candidate : undefined;
	const identifiers = normalizePaperIdentifiers(
		('resource' in input ? input.resource.resourceIdentifiers : input.identifiers).filter((identifier): identifier is PaperIdentifier =>
			isPaperIdentifierScheme(identifier.scheme),
		),
	);
	const doi = paperIdentityFromIdentifiers(identifiers)?.doi;
	const provider = parsed?.fileType === PDF_MIME && (candidate || (doi && !doi.startsWith('10.48550/arxiv.'))) ? 'crossref' : 'openalex';
	let openAlex: Awaited<ReturnType<typeof resolveOpenAlexPaper>> = null;
	let crossref: Awaited<ReturnType<typeof resolveCrossrefPaper>> = null;
	if (provider === 'crossref' ? doi || candidate : identifiers.length) {
		const startedAt = Date.now();
		try {
			if (provider === 'crossref') {
				const stream = await step.do(
					doi ? 'resolve-pdf-paper-crossref-by-doi-v3' : 'confirm-stored-pdf-with-crossref-v3',
					PAPER_METADATA_STEP,
					async () =>
						Response.json(doi ? await resolveCrossrefPaper(doi) : await resolveCrossrefPaperCandidate(candidate!.title, candidate!.authors))
							.body!,
				);
				crossref = await new Response(stream).json<Awaited<ReturnType<typeof resolveCrossrefPaper>>>();
			} else {
				const stream = await step.do(
					'resolve-paper-openalex-with-citations-v5',
					PAPER_METADATA_STEP,
					async () => Response.json(await resolveOpenAlexPaper({ apiKey: env.OPENALEX_API_KEY, identifiers })).body!,
				);
				openAlex = await new Response(stream).json<Awaited<ReturnType<typeof resolveOpenAlexPaper>>>();
			}
			console.info({
				tag: 'PAPER_PROVIDER',
				event: 'academic_enrichment',
				provider,
				processing_id: input.processingId,
				outcome: openAlex || crossref ? 'resolved' : 'not_found',
				latency_ms: Date.now() - startedAt,
			});
		} catch (error) {
			console.warn({
				tag: 'PAPER_PROVIDER',
				event: 'academic_enrichment',
				provider,
				processing_id: input.processingId,
				outcome: 'failed',
				latency_ms: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const sourceUrl = 'resource' in input ? input.resource.url : input.url;
	const publicPdfUrl = openAlex?.metadata.pdfUrl;
	const pdf =
		parsed?.fileType !== PDF_MIME && openAlex
			? await stagePaperPdfContent(env, step, {
					contentPdfUrl: openAlex.contentPdfUrl,
					publicPdfUrl: publicPdfUrl && publicPdfUrl !== sourceUrl ? publicPdfUrl : null,
					processingId: input.processingId,
				})
			: null;
	const resource =
		'resource' in input
			? { ...input.resource, ...(pdf ? { content: pdf.content, references: pdf.references, fileType: pdf.fileType } : {}) }
			: pdf
				? { ...pdf, url: input.url, source: new URL(input.url).hostname }
				: await stageWebAcquisition(env, step, input);
	if ('platform' in resource) return resource;
	if (!resource.content.trim()) throw new Error(`Processing ${input.processingId} has no extractable content`);
	const { doi: _doi, abstract, authors, publicationDate, title, ...kindMetadata } = { ...openAlex?.metadata, ...crossref };
	const resourceIdentifiers =
		openAlex?.identifiers ??
		normalizePaperIdentifiers([
			...(crossref ? paperIdentifiersFromIdentity({ doi: crossref.doi }) : []),
			...identifiers,
			...resource.resourceIdentifiers.filter((identifier): identifier is PaperIdentifier => isPaperIdentifierScheme(identifier.scheme)),
		]);
	const identity = paperIdentityFromIdentifiers(resourceIdentifiers);
	if (!identity) return resource;
	let publishedDate = resource.publishedDate;
	if (!publishedDate && publicationDate) {
		const candidate = new Date(`${publicationDate}T00:00:00.000Z`);
		if (!Number.isNaN(candidate.getTime())) publishedDate = candidate.toISOString();
	}
	return {
		...resource,
		kind: 'paper',
		resourcePlatform: null,
		resourceIdentifiers,
		url: resource.url ?? canonicalPaperUrl(identity),
		title: title?.trim() || resource.title,
		summary: abstract?.trim() || resource.summary,
		publishedDate,
		creators: authors?.length ? authors.map((literal) => ({ role: 'author', literal })) : resource.creators,
		kindMetadata,
	} satisfies AcquiredResource;
}
