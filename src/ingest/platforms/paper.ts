// Provider-independent bibliographic resolution followed by OpenAlex enrichment.

import type { WorkflowStep } from 'cloudflare:workers';
import {
	normalizePaperIdentifiers,
	PAPER_IDENTIFIER_SCHEMES,
	type PaperIdentifier,
	type PaperIdentifierScheme,
	paperIdentifiersFromIdentity,
	paperIdentityFromText,
	resolveExactPaperInput,
} from '@core-shared/paper-identity';
import type { PaperKindMetadata } from '@core-shared/resource';
import { z } from 'zod';
import { type GenericAcquiredMaterial, literalCreator } from './materialize';
import { fetchOpenAlexPdf, type PaperMetadata, resolveOpenAlexPaper } from './openalex';
import { acquireFetchedPdfResponse, PDF_MIME } from './pdf';

const IDENTIFIER_SCAN_CHARS = 3_000;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';
const CITOID_BASE = 'https://en.wikipedia.org/api/rest_v1/data/citation/zotero/';
const CITOID_TIMEOUT_MS = 8_000;
const CITOID_USER_AGENT = 'Newsence/1.0 (https://www.newsence.app; bibliographic metadata resolver)';
const CitoidResponseSchema = z.array(
	z
		.object({
			itemType: z.string().nullish(),
			DOI: z.string().nullish(),
			archiveID: z.string().nullish(),
			url: z.string().nullish(),
			extra: z.string().nullish(),
		})
		.passthrough(),
);
const ACADEMIC_ITEM_TYPES = new Set(['journalArticle', 'conferencePaper', 'preprint', 'thesis', 'manuscript']);

function applyPaperMetadata(
	acquiredContent: GenericAcquiredMaterial,
	metadata: PaperMetadata | null,
	publishedDate: string | null,
): { acquiredContent: GenericAcquiredMaterial; publishedDate: string | null } {
	if (!metadata) return { acquiredContent, publishedDate };
	if (!publishedDate && metadata.publicationDate) {
		const candidate = new Date(`${metadata.publicationDate}T00:00:00.000Z`);
		if (!Number.isNaN(candidate.getTime())) publishedDate = candidate.toISOString();
	}
	const abstract = metadata.abstract?.trim();
	const title = metadata.title?.trim();
	const kindMetadata: PaperKindMetadata = {
		...(metadata.venue?.trim() ? { venue: metadata.venue.trim() } : {}),
		...(metadata.year === undefined ? {} : { year: metadata.year }),
		...(metadata.citedByCount === undefined ? {} : { citedByCount: metadata.citedByCount }),
		...(metadata.referenceCount === undefined ? {} : { referenceCount: metadata.referenceCount }),
		...(metadata.pdfUrl?.trim() ? { pdfUrl: metadata.pdfUrl.trim() } : {}),
		...(metadata.references ? { references: metadata.references } : {}),
		...(metadata.citations ? { citations: metadata.citations } : {}),
	};
	return {
		acquiredContent: {
			...acquiredContent,
			...(title ? { title } : {}),
			...(abstract ? { summary: abstract } : {}),
			creators: metadata.authors.flatMap((author) => literalCreator('author', author)),
			kindMetadata,
		},
		publishedDate,
	};
}

function choosePreferredIdentifiers(identifiers: readonly PaperIdentifier[]): PaperIdentifier[] {
	const normalized = normalizePaperIdentifiers(identifiers.map((identifier) => ({ ...identifier, preferred: false })));
	const preferred = new Map<PaperIdentifierScheme, string>();
	for (const scheme of PAPER_IDENTIFIER_SCHEMES) {
		const candidates = normalized.filter((identifier) => identifier.scheme === scheme);
		const selected =
			scheme === 'doi' ? (candidates.find((identifier) => !identifier.value.startsWith(ARXIV_DOI_PREFIX)) ?? candidates[0]) : candidates[0];
		if (selected) preferred.set(scheme, selected.value);
	}
	return normalizePaperIdentifiers(
		normalized.map((identifier) => ({
			...identifier,
			preferred: preferred.get(identifier.scheme) === identifier.value,
		})),
	);
}

async function resolveCitoidPaperIdentifiers(value: string): Promise<PaperIdentifier[]> {
	const parsedUrl = URL.parse(value);
	if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.username || parsedUrl.password) {
		return [];
	}
	const url = parsedUrl.toString();
	const response = await fetch(`${CITOID_BASE}${encodeURIComponent(url)}`, {
		headers: { Accept: 'application/json', 'Api-User-Agent': CITOID_USER_AGENT, 'User-Agent': CITOID_USER_AGENT },
		signal: AbortSignal.timeout(CITOID_TIMEOUT_MS),
	});
	if (!response.ok) {
		const status = response.status;
		const retryAfter = response.headers.get('retry-after');
		await response.body?.cancel();
		if (status === 429) {
			throw new Error(`Citoid request failed with HTTP 429${retryAfter ? `; retry_after_seconds=${retryAfter}` : ''}`);
		}
		console.warn({ tag: 'CITOID', event: 'lookup_unavailable', status });
		return [];
	}
	const items = CitoidResponseSchema.parse(await response.json());
	const academicItem = items.find((item) => item.itemType && ACADEMIC_ITEM_TYPES.has(item.itemType));
	if (!academicItem) return [];
	const identity = paperIdentityFromText(
		[
			academicItem.DOI ? `DOI: ${academicItem.DOI}` : '',
			academicItem.archiveID ?? '',
			academicItem.url ?? '',
			academicItem.extra?.slice(0, IDENTIFIER_SCAN_CHARS) ?? '',
		]
			.filter(Boolean)
			.join('\n'),
	);
	return identity ? paperIdentifiersFromIdentity(identity) : [];
}

function localPaperIdentifiers(input: {
	canonicalUrl: string | null;
	identifierText: string | null;
	seedIdentifiers: readonly PaperIdentifier[];
	sourceUrl: string | null;
}): PaperIdentifier[] {
	const exact =
		resolveExactPaperInput(input.sourceUrl)?.identity ??
		(input.canonicalUrl === input.sourceUrl ? null : resolveExactPaperInput(input.canonicalUrl)?.identity);
	const fromText = input.identifierText?.trim() ? paperIdentityFromText(input.identifierText.slice(0, IDENTIFIER_SCAN_CHARS)) : null;
	return choosePreferredIdentifiers([
		...(exact ? paperIdentifiersFromIdentity(exact) : []),
		...(fromText ? paperIdentifiersFromIdentity(fromText) : []),
		...input.seedIdentifiers,
	]);
}

async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: {
		citoidUrl: string | null;
		identifiers: readonly PaperIdentifier[];
		processingId: string;
	},
) {
	if (!candidate.identifiers.length && !candidate.citoidUrl) {
		return { contentPdfUrl: null, identifiers: [], metadata: null };
	}
	const attemptStartedAt = Date.now();

	try {
		const resolution = await step.do(
			'resolve-paper-openalex-with-citations-v2',
			{ retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const citoid = candidate.citoidUrl
					? await resolveCitoidPaperIdentifiers(candidate.citoidUrl).catch((error) => {
							if (error instanceof Error && error.message.includes('HTTP 429')) throw error;
							console.warn({
								tag: 'CITOID',
								event: 'lookup_failed',
								error: error instanceof Error ? error.message : String(error),
							});
							return [];
						})
					: [];
				const bibliographic = choosePreferredIdentifiers([...candidate.identifiers, ...citoid]);
				if (bibliographic.length === 0) {
					return null;
				}
				const resolved = await resolveOpenAlexPaper({
					apiKey: env.OPENALEX_API_KEY,
					identifiers: bibliographic,
				});
				const paper = resolved?.metadata ?? null;
				console.info({
					tag: 'PAPER_PROVIDER',
					event: 'academic_enrichment',
					provider: 'openalex',
					processing_id: candidate.processingId,
					identity_schemes: [...new Set(bibliographic.map(({ scheme }) => scheme))],
					outcome: paper ? 'resolved' : 'not_found',
					latency_ms: Date.now() - startedAt,
				});
				return { identifiers: bibliographic, resolved };
			},
		);
		return {
			contentPdfUrl: resolution?.resolved?.contentPdfUrl ?? null,
			identifiers: resolution?.resolved?.identifiers ?? resolution?.identifiers ?? [],
			metadata: resolution?.resolved?.metadata ?? null,
		};
	} catch (error) {
		console.warn({
			tag: 'PAPER_PROVIDER',
			event: 'academic_enrichment',
			processing_id: candidate.processingId,
			outcome: 'failed',
			latency_ms: Date.now() - attemptStartedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			contentPdfUrl: null,
			identifiers: [],
			metadata: null,
		};
	}
}

async function stageOpenAlexPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquiredContent: GenericAcquiredMaterial;
		canonicalUrl: string | null;
		contentPdfUrl: string;
		metadata: PaperMetadata | null;
		originSummary: string | null;
		publishedDate: string | null;
		processingId: string;
	},
): Promise<GenericAcquiredMaterial | null> {
	const sourceName = input.acquiredContent.source.trim() || (input.canonicalUrl ? new URL(input.canonicalUrl).hostname : 'OpenAlex');
	const description = input.metadata?.abstract?.trim() || input.acquiredContent.summary || input.originSummary;
	const publishedDate = input.metadata?.publicationDate?.trim() || input.publishedDate;
	const title = input.metadata?.title?.trim() || input.acquiredContent.title;

	const contentStream = await step
		.do(
			'acquire-openalex-content-pdf-v2',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			async () => {
				const response = await fetchOpenAlexPdf({ apiKey: env.OPENALEX_API_KEY, contentPdfUrl: input.contentPdfUrl });
				const acquired = await acquireFetchedPdfResponse(response, input.contentPdfUrl);
				return Response.json({
					...acquired,
					title,
					source: sourceName,
					publishedDate,
					summary: description,
					kindMetadata: { siteName: sourceName },
				}).body!;
			},
		)
		.catch((error) => {
			console.error({
				tag: 'OPENALEX_CONTENT',
				event: 'pdf_acquisition_failed',
				processing_id: input.processingId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	if (!contentStream) return null;
	const acquired = await new Response(contentStream).json<GenericAcquiredMaterial>();
	console.info({
		tag: 'OPENALEX_CONTENT',
		event: 'pdf_acquired',
		processing_id: input.processingId,
		chars: acquired.markdown.length,
	});
	return acquired;
}

export async function stagePaperProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquiredContent: GenericAcquiredMaterial;
		canonicalUrl: string | null;
		originSummary: string | null;
		processingId: string;
		publishedDate: string | null;
		seedIdentifiers: readonly PaperIdentifier[];
		sourceUrl: string | null;
		allowCitoidLookup: boolean;
	},
) {
	const identifiers = localPaperIdentifiers({
		canonicalUrl: input.canonicalUrl,
		identifierText: input.acquiredContent.fileType === PDF_MIME ? input.acquiredContent.markdown : null,
		seedIdentifiers: input.seedIdentifiers,
		sourceUrl: input.sourceUrl,
	});
	const resolution = await stagePaperEnrichment(env, step, {
		citoidUrl: identifiers.length || !input.allowCitoidLookup ? null : input.canonicalUrl,
		identifiers,
		processingId: input.processingId,
	});
	const acquiredContent =
		input.acquiredContent.fileType === PDF_MIME || !resolution.contentPdfUrl
			? input.acquiredContent
			: ((await stageOpenAlexPdfAcquisition(env, step, {
					acquiredContent: input.acquiredContent,
					canonicalUrl: input.canonicalUrl,
					contentPdfUrl: resolution.contentPdfUrl,
					metadata: resolution.metadata,
					originSummary: input.originSummary,
					processingId: input.processingId,
					publishedDate: input.publishedDate,
				})) ?? input.acquiredContent);
	const resourceIdentifiers = choosePreferredIdentifiers([...identifiers, ...resolution.identifiers]);
	const identity = resourceIdentifiers.some(({ scheme }) => scheme === 'openalex')
		? { kind: 'paper' as const, resourceIdentifiers }
		: { kind: 'blog' as const, resourceIdentifiers: [] as const };
	return { ...applyPaperMetadata(acquiredContent, resolution.metadata, input.publishedDate), identity };
}
