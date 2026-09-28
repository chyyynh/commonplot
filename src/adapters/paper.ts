import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import type { AcquiredResource } from '../contracts/acquired-resource';
import {
	canonicalPaperUrl,
	isPaperIdentifierScheme,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	mergePaperIdentifiers,
	type PaperIdentifier,
	paperIdentityFromIdentifiers,
	titlePageNamesTitle,
} from '../contracts/paper-identity';
import type { ResourceIdentifier } from '../contracts/resource';
import { readBoundedResponseText } from '../services/response';
import { storePublicPdfResponse } from '../services/zotero-sdt-service.ts';
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

/** OpenAlex's hosted copy of a licensed PDF; publisher servers often refuse automated downloads. */
async function stagePaperPdfContent(env: CoreEnv, step: WorkflowStep, input: { contentPdfUrl: string; processingId: string }) {
	try {
		const source = await step.do(
			'download-paper-openalex-pdf-v1',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
			async () => {
				const apiKey = env.OPENALEX_API_KEY?.trim();
				if (!apiKey) throw new NonRetryableError('OpenAlex content download requires an API key');
				const requestUrl = new URL(input.contentPdfUrl);
				requestUrl.searchParams.set('api_key', apiKey);
				const response = await fetch(requestUrl, {
					headers: { Accept: 'application/pdf' },
					signal: AbortSignal.timeout(CONTENT_REQUEST_TIMEOUT_MS),
				});
				if (!response.ok) {
					await response.body?.cancel();
					const ErrorType = [400, 401, 403, 404, 410, 422].includes(response.status) ? NonRetryableError : Error;
					throw new ErrorType(`OpenAlex PDF request failed with HTTP ${response.status}`);
				}
				// The checkpoint keeps the key-free URL.
				return storePublicPdfResponse(env, response, input.contentPdfUrl);
			},
		);
		const resource = await stagePublicPdfAcquisition(env, step, source);
		console.info({ tag: 'PAPER_CONTENT', event: 'pdf_acquired', processing_id: input.processingId, chars: resource.content.length });
		return resource;
	} catch (error) {
		console.error({
			tag: 'PAPER_CONTENT',
			event: 'pdf_acquisition_failed',
			processing_id: input.processingId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

type PaperMetadata = NonNullable<Awaited<ReturnType<typeof resolveOpenAlexPaper>>>;

/**
 * OpenAlex describes every paper. Identifiers read from a PDF only count when the
 * resolved title appears on that PDF's title page; `titlePageText` is omitted for
 * identifiers taken from the link itself.
 */
async function stagePaperMetadata(
	env: CoreEnv,
	step: WorkflowStep,
	input: { identifiers: PaperIdentifier[]; titlePageText?: string | null; processingId: string },
): Promise<PaperMetadata | null> {
	if (!input.identifiers.length) return null;
	const startedAt = Date.now();
	const stream = await step.do(
		'resolve-paper-openalex-v6',
		PAPER_METADATA_STEP,
		async () => Response.json(await resolveOpenAlexPaper({ apiKey: env.OPENALEX_API_KEY, identifiers: input.identifiers })).body!,
	);
	const work = await new Response(stream).json<PaperMetadata | null>();
	const verified =
		!work ||
		input.titlePageText === undefined ||
		(!!input.titlePageText && !!work.metadata.title && titlePageNamesTitle(input.titlePageText, work.metadata.title));
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

/**
 * Readable full text, best source first: arXiv's HTML, then a licensed PDF. arXiv's rendering
 * needs no metadata, so a paper OpenAlex has not indexed yet still reads.
 */
async function stagePaperFullText(
	env: CoreEnv,
	step: WorkflowStep,
	input: { identifiers: readonly PaperIdentifier[]; contentPdfUrl: string | null; processingId: string },
) {
	const arxivId = paperIdentityFromIdentifiers(input.identifiers)?.arxivId;
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
	if (!input.contentPdfUrl) return null;
	return stagePaperPdfContent(env, step, { contentPdfUrl: input.contentPdfUrl, processingId: input.processingId });
}

/**
 * A paper reads as its full text, else its abstract; null when it has neither, or when
 * identifiers read from a PDF (`titlePageText` given) resolve to a work not named on it.
 * Without `url` the paper lives at its canonical identifier URL, not at the source it was read from.
 */
export async function stagePaper(
	env: CoreEnv,
	step: WorkflowStep,
	input: { identifiers: readonly ResourceIdentifier[]; titlePageText?: string | null; url: string | null; processingId: string },
): Promise<(AcquiredResource & { kind: 'paper'; resourcePlatform: null }) | null> {
	const identifiers = mergePaperIdentifiers(
		input.identifiers.filter((identifier): identifier is PaperIdentifier => isPaperIdentifierScheme(identifier.scheme)),
	);
	const work = await stagePaperMetadata(env, step, { identifiers, titlePageText: input.titlePageText, processingId: input.processingId });
	if (!work && input.titlePageText !== undefined) return null;
	const resourceIdentifiers = work?.identifiers ?? identifiers;
	const fullText = await stagePaperFullText(env, step, {
		identifiers: resourceIdentifiers,
		contentPdfUrl: work?.contentPdfUrl ?? null,
		processingId: input.processingId,
	});
	const { abstract, authors, publicationDate, title, ...kindMetadata } = work?.metadata ?? {};
	const content = fullText?.content ?? abstract?.trim();
	if (!content) return null;
	const identity = paperIdentityFromIdentifiers(resourceIdentifiers);
	if (!identity) throw new TypeError('A paper requires a DOI, arXiv, or OpenAlex identifier');
	const url = input.url ?? canonicalPaperUrl(identity);
	const publishedDate = publicationDate ? new Date(`${publicationDate}T00:00:00.000Z`) : null;
	return {
		kind: 'paper',
		resourcePlatform: null,
		resourceIdentifiers,
		url,
		source: new URL(url).hostname,
		fileType: fullText?.fileType ?? null,
		title: title?.trim() || fullText?.title || null,
		summary: abstract?.trim() || null,
		content,
		references: fullText?.references ?? [],
		originalLang: fullText?.originalLang ?? 'und',
		publishedDate: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : null,
		creators: authors?.length ? authors.map((literal) => ({ role: 'author', literal })) : (fullText?.creators ?? []),
		kindMetadata,
		previewImageUrl: fullText?.previewImageUrl ?? null,
		subjectUrl: fullText?.subjectUrl ?? null,
	};
}
