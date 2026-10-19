import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import type { AcquiredResource, ReadDocument } from '../contracts/acquired-resource';
import {
	canonicalPaperUrl,
	isPaperIdentifierScheme,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	mergePaperIdentifiers,
	type PaperIdentifier,
	paperIdentifiersFromIdentity,
	paperIdentityFromIdentifiers,
} from '../contracts/paper-identity';
import type { ResourceIdentifier } from '../contracts/resource';
import { lookupDoiWork, searchCrossrefWorks, type WorkCandidate } from '../services/crossref';
import { errorMessage, fetchOk, readBoundedResponseText } from '../services/response';
import { stepJson } from '../services/workflow-step';
import { stagePdfDocument, storePublicPdfResponse } from '../services/zotero-sdt-service.ts';
import { stageArxivHtmlAcquisition } from './arxiv-html';

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
	return mergePaperIdentifiers([
		...paperIdentifiersFromIdentity({
			doi: doi && doi !== arxivProxyDoi ? doi : undefined,
			arxivId: arxivId ?? undefined,
			openAlexId: normalizeOpenAlexId(work.id) ?? undefined,
		}),
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
	const response = await fetchOk(`${OPENALEX_BASE}/works/${workId}?select=${WORK_FIELDS}`, {
		label: 'OpenAlex request',
		timeoutMs: REQUEST_TIMEOUT_MS,
		permanent: [400, 401, 403, 410, 422],
		missing: [404],
		headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
	});
	if (!response) return null;
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
				// Only a paper OpenAlex resolved, which needs the API key, has a content PDF URL.
				const requestUrl = new URL(input.contentPdfUrl);
				requestUrl.searchParams.set('api_key', env.OPENALEX_API_KEY.trim());
				const response = await fetchOk(requestUrl, {
					label: 'OpenAlex PDF request',
					timeoutMs: CONTENT_REQUEST_TIMEOUT_MS,
					permanent: [400, 401, 403, 404, 410, 422],
					headers: { Accept: 'application/pdf' },
				});
				// The checkpoint keeps the key-free URL.
				return storePublicPdfResponse(env, response, input.contentPdfUrl);
			},
		);
		const resource = await stagePdfDocument(env, step, source);
		console.info({ tag: 'PAPER_CONTENT', event: 'pdf_acquired', processing_id: input.processingId, chars: resource.content.length });
		return resource;
	} catch (error) {
		console.error({
			tag: 'PAPER_CONTENT',
			event: 'pdf_acquisition_failed',
			processing_id: input.processingId,
			error: errorMessage(error),
		});
		return null;
	}
}

/** OpenAlex describes every paper it has indexed; OpenAlex failing after its retries reads as not indexed. */
async function stagePaperMetadata(env: CoreEnv, step: WorkflowStep, input: { identifiers: PaperIdentifier[]; processingId: string }) {
	const startedAt = Date.now();
	const work = await stepJson(step, 'resolve-paper-openalex-v7', PAPER_METADATA_STEP, () =>
		resolveOpenAlexPaper({ apiKey: env.OPENALEX_API_KEY, identifiers: input.identifiers }),
	).catch((error: unknown) => {
		console.error({
			tag: 'PAPER_PROVIDER',
			event: 'paper_metadata_failed',
			provider: 'openalex',
			processing_id: input.processingId,
			error: errorMessage(error),
		});
		return null;
	});
	console.info({
		tag: 'PAPER_PROVIDER',
		event: 'paper_metadata',
		provider: 'openalex',
		processing_id: input.processingId,
		outcome: work ? 'resolved' : 'not_found',
		latency_ms: Date.now() - startedAt,
	});
	return work;
}

/** arXiv's HTML rendering, which needs no metadata, so a paper OpenAlex has not indexed yet still reads. */
async function stageArxivFullText(step: WorkflowStep, arxivId: string, processingId: string) {
	try {
		return await stageArxivHtmlAcquisition(step, arxivId);
	} catch (error) {
		console.error({
			tag: 'PAPER_CONTENT',
			event: 'arxiv_html_failed',
			processing_id: processingId,
			error: errorMessage(error),
		});
		return null;
	}
}

/**
 * A paper reads as its full text, else its abstract; null when it has neither. Full text is, best source first, the PDF it
 * was identified from (`pdf`), arXiv's HTML, then a licensed PDF; arXiv's is fetched alongside OpenAlex when the
 * identifiers already name it. Without an OpenAlex record, the work its PDF was identified as describes it. The paper
 * lives at its canonical identifier URL, not at the source it was read from.
 */
export async function stagePaper(
	env: CoreEnv,
	step: WorkflowStep,
	input: { identifiers: readonly ResourceIdentifier[]; pdf?: ReadDocument; candidate?: WorkCandidate; processingId: string },
): Promise<(AcquiredResource & { kind: 'paper'; resourcePlatform: null }) | null> {
	const identifiers = mergePaperIdentifiers(
		input.identifiers.filter((identifier): identifier is PaperIdentifier => isPaperIdentifierScheme(identifier.scheme)),
	);
	const knownArxivId = input.pdf ? undefined : paperIdentityFromIdentifiers(identifiers)?.arxivId;
	const [work, knownArxivHtml] = await Promise.all([
		stagePaperMetadata(env, step, { identifiers, processingId: input.processingId }),
		knownArxivId ? stageArxivFullText(step, knownArxivId, input.processingId) : null,
	]);
	const resourceIdentifiers = work?.identifiers ?? identifiers;
	const identity = paperIdentityFromIdentifiers(resourceIdentifiers);
	if (!identity) throw new TypeError('A paper requires a DOI, arXiv, or OpenAlex identifier');
	const url = canonicalPaperUrl(identity);
	const resolvedArxivId = identity.arxivId && identity.arxivId !== knownArxivId ? identity.arxivId : undefined;
	const fullText: FullText | null =
		input.pdf ??
		knownArxivHtml ??
		(resolvedArxivId ? await stageArxivFullText(step, resolvedArxivId, input.processingId) : null) ??
		(work?.contentPdfUrl
			? await stagePaperPdfContent(env, step, { contentPdfUrl: work.contentPdfUrl, processingId: input.processingId })
			: null);
	const { candidate } = input;
	const { abstract, authors, publicationDate, title, ...kindMetadata } = work?.metadata ?? {
		title: candidate?.title,
		authors: candidate?.authors,
		abstract: undefined,
		publicationDate: undefined,
		...(candidate?.venue ? { venue: candidate.venue } : {}),
		...(candidate?.year ? { year: candidate.year } : {}),
	};
	const content = fullText?.content ?? abstract?.trim();
	if (!content) return null;
	const publishedDate = publicationDate ? new Date(`${publicationDate}T00:00:00.000Z`) : null;
	return {
		kind: 'paper',
		resourcePlatform: null,
		resourceIdentifiers,
		url,
		source: new URL(url).hostname,
		fileType: fullText?.fileType ?? null,
		...(fullText?.pdfHash ? { pdfHash: fullText.pdfHash } : {}),
		title: title?.trim() || fullText?.title || null,
		summary: abstract?.trim() || null,
		content,
		references: fullText?.references ?? [],
		originalLang: fullText?.originalLang ?? 'und',
		publishedDate: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : null,
		creators: authors?.length ? authors.map((literal) => ({ role: 'author', literal })) : (fullText?.creators ?? []),
		kindMetadata,
		previewImageUrl: null,
		subjectUrl: null,
	};
}

/** What a paper's full text gives it, from its PDF or arXiv's HTML. */
type FullText = Pick<AcquiredResource, 'title' | 'content' | 'creators'> &
	Partial<Pick<AcquiredResource, 'references' | 'fileType' | 'pdfHash' | 'originalLang'>>;

const MAX_WORK_CANDIDATES = 6;

/**
 * The works a PDF may be: those whose DOI or arXiv id it prints, as doi.org describes them, and Crossref's matches for the
 * title it prints. Whether it is any of them is Jev's to judge, so a cover page's proceedings DOI is only a candidate.
 */
export async function stageWorkCandidates(step: WorkflowStep, printed: NonNullable<ReadDocument['printed']>, processingId: string) {
	const dois = [printed.doi, printed.arxivId && `10.48550/arxiv.${printed.arxivId}`].filter((doi): doi is string => !!doi);
	if (!dois.length && !printed.title) return [];
	return stepJson(step, 'find-work-candidates-v1', PAPER_METADATA_STEP, async () => {
		const found = await Promise.allSettled([
			...dois.map((doi) => lookupDoiWork(doi)),
			printed.title ? searchCrossrefWorks(printed.title) : [],
		]);
		const candidates = new Map<string, WorkCandidate>();
		for (const result of found) {
			if (result.status === 'rejected') {
				console.warn({
					tag: 'PAPER_PROVIDER',
					event: 'work_candidates_failed',
					processing_id: processingId,
					error: errorMessage(result.reason),
				});
				continue;
			}
			for (const candidate of [result.value].flat())
				if (candidate && !candidates.has(candidate.doi)) candidates.set(candidate.doi, candidate);
		}
		return [...candidates.values()].slice(0, MAX_WORK_CANDIDATES);
	});
}
