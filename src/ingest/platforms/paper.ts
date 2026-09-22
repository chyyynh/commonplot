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
import type { AcquiredResource } from '../acquisition';
import { resolveCrossrefPaper, resolveCrossrefPaperCandidate } from '../crossref';
import { storePublicPdfResponse } from '../zotero-sdt-service.ts';
import { stagePublicPdfAcquisition } from './pdf';
import { PDF_MIME } from './pdf-policy';
import type { ResolvedResourceUrl } from './resource-url';
import { stageWebAcquisition } from './web';

const PAPER_METADATA_STEP = { retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;

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

async function resolveOpenAlexPaper(input: { apiKey?: string; identifiers: readonly PaperIdentifier[] }) {
	const apiKey = input.apiKey?.trim();
	if (!apiKey) return null;
	const identifiers = normalizePaperIdentifiers(input.identifiers);
	const identity = paperIdentityFromIdentifiers(identifiers);
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
	const work = OpenAlexWorkSchema.parse(await response.json());
	return normalizeOpenAlexWork(work, identifiers);
}

/** OpenAlex content URLs need our API key, so this optional representation is always local-only. */
async function stageOpenAlexPdfContent(env: CoreEnv, step: WorkflowStep, input: { contentPdfUrl: string; processingId: string }) {
	try {
		const source = await step.do(
			'download-openalex-content-pdf-v1',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
			async () => {
				const apiKey = env.OPENALEX_API_KEY?.trim();
				if (!apiKey) throw new Error('OpenAlex content download requires an API key');
				const contentUrl = new URL(input.contentPdfUrl);
				contentUrl.searchParams.set('api_key', apiKey);
				const response = await fetch(contentUrl, {
					headers: { Accept: 'application/pdf' },
					signal: AbortSignal.timeout(CONTENT_REQUEST_TIMEOUT_MS),
				});
				if (!response.ok) {
					await response.body?.cancel();
					const ErrorType = [400, 401, 403, 404, 410, 422].includes(response.status) ? NonRetryableError : Error;
					throw new ErrorType(`OpenAlex content PDF request failed with HTTP ${response.status}`);
				}
				return storePublicPdfResponse(env, response, input.contentPdfUrl);
			},
		);
		const resource = await stagePublicPdfAcquisition(env, step, { source, grant: null, processingId: input.processingId });
		console.info({
			tag: 'OPENALEX_CONTENT',
			event: 'pdf_acquired',
			processing_id: input.processingId,
			chars: resource.content.length,
		});
		return resource;
	} catch (error) {
		console.error({
			tag: 'OPENALEX_CONTENT',
			event: 'pdf_acquisition_failed',
			processing_id: input.processingId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

type ParsedPaperInput = {
	resource: AcquiredResource & { resourcePlatform: null };
	/** Only a GROBID header may propose an uploaded PDF without an identifier. */
	candidate?: { title: string; authors: readonly string[] };
	processingId: string;
};

type PaperUrlInput = Parameters<typeof stageWebAcquisition>[2] & {
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
				crossref = doi
					? await step.do('resolve-pdf-paper-crossref-by-doi-v2', PAPER_METADATA_STEP, () => resolveCrossrefPaper(doi))
					: await step.do('confirm-stored-pdf-with-crossref-v2', PAPER_METADATA_STEP, () =>
							resolveCrossrefPaperCandidate(candidate!.title, candidate!.authors),
						);
			} else {
				openAlex = await step.do('resolve-paper-openalex-with-citations-v4', PAPER_METADATA_STEP, () =>
					resolveOpenAlexPaper({ apiKey: env.OPENALEX_API_KEY, identifiers }),
				);
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
	const { doi: _doi, abstract, authors, publicationDate, title, ...kindMetadata } = { ...openAlex?.metadata, ...crossref };
	const pdf =
		parsed?.fileType !== PDF_MIME && openAlex?.contentPdfUrl
			? await stageOpenAlexPdfContent(env, step, { contentPdfUrl: openAlex.contentPdfUrl, processingId: input.processingId })
			: null;
	const resource =
		'resource' in input
			? input.resource
			: pdf
				? { ...pdf, url: input.url, source: new URL(input.url).hostname }
				: await stageWebAcquisition(env, step, input);
	if ('platform' in resource) return resource;
	const canonicalUrl = resource.url;
	const content = pdf?.content ?? resource.content;
	if (!content.trim()) throw new Error(`Processing ${input.processingId} has no extractable content`);
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
		url: canonicalUrl ?? canonicalPaperUrl(identity),
		title: title?.trim() || resource.title,
		summary: abstract?.trim() || resource.summary,
		content,
		references: pdf ? pdf.references : resource.references,
		source: pdf ? resource.source.trim() || (canonicalUrl ? new URL(canonicalUrl).hostname : 'OpenAlex') : resource.source,
		publishedDate,
		creators: authors?.length ? authors.map((literal) => ({ role: 'author', literal })) : resource.creators,
		kindMetadata,
		fileType: pdf ? PDF_MIME : resource.fileType,
	} satisfies AcquiredResource;
}
