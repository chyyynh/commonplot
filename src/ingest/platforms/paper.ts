// Provider-independent bibliographic resolution followed by OpenAlex enrichment.

import type { WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import {
	normalizePaperIdentifiers,
	PAPER_IDENTIFIER_SCHEMES,
	type PaperIdentifier,
	type PaperIdentifierScheme,
	paperIdentifiersFromIdentity,
	paperIdentityFromText,
	resolveExactPaperInput,
} from '../../shared/paper-identity';
import type { PaperKindMetadata } from '../../shared/resource';
import { type PdfWorkflowIdentity, resolvePublicPdfAcquisition } from './llama-parse';
import { type GenericAcquiredMaterial, literalCreator } from './materialize';
import { fetchOpenAlexPdf, type PaperMetadata, resolveOpenAlexPaper } from './openalex';
import { acquireFetchedPdfResponse, type LocalPdfAcquisition, PDF_MIME } from './pdf';

const CITOID_IDENTIFIER_SCAN_CHARS = 3_000;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';
const CITOID_BASE = 'https://en.wikipedia.org/api/rest_v1/data/citation/zotero/';
const CITOID_TIMEOUT_MS = 8_000;
const CITOID_USER_AGENT = 'Newsence/1.0 (https://www.newsence.app; bibliographic metadata resolver)';
const CitoidResponseSchema = z.array(
	z.object({
		itemType: z.string().nullish(),
		DOI: z.string().nullish(),
		archiveID: z.string().nullish(),
		url: z.string().nullish(),
		extra: z.string().nullish(),
	}),
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
			academicItem.extra?.slice(0, CITOID_IDENTIFIER_SCAN_CHARS) ?? '',
		]
			.filter(Boolean)
			.join('\n'),
	);
	return identity ? paperIdentifiersFromIdentity(identity) : [];
}

function localPaperIdentifiers(input: {
	canonicalUrl: string | null;
	documentTitle: string | null;
	identifierText: string | null;
	seedIdentifiers: readonly PaperIdentifier[];
	sourceUrl: string | null;
}): PaperIdentifier[] {
	const exact = [input.sourceUrl, input.canonicalUrl === input.sourceUrl ? null : input.canonicalUrl, input.documentTitle].flatMap(
		(value) => {
			const resolved = resolveExactPaperInput(value);
			return resolved ? paperIdentifiersFromIdentity(resolved.identity) : [];
		},
	);
	const fromText = input.identifierText?.trim() ? paperIdentityFromText(input.identifierText) : null;
	return choosePreferredIdentifiers([...exact, ...(fromText ? paperIdentifiersFromIdentity(fromText) : []), ...input.seedIdentifiers]);
}

async function stageCitoidPaperIdentifiers(
	step: WorkflowStep,
	candidate: {
		citoidUrl: string;
		processingId: string;
	},
): Promise<PaperIdentifier[]> {
	try {
		return await step.do(
			'resolve-paper-citoid-identifiers-v1',
			{ retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () =>
				resolveCitoidPaperIdentifiers(candidate.citoidUrl).catch((error) => {
					if (error instanceof Error && error.message.includes('HTTP 429')) throw error;
					console.warn({
						tag: 'CITOID',
						event: 'lookup_failed',
						processing_id: candidate.processingId,
						error: error instanceof Error ? error.message : String(error),
					});
					return [];
				}),
		);
	} catch (error) {
		console.warn({
			tag: 'CITOID',
			event: 'lookup_failed',
			processing_id: candidate.processingId,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

async function stageOpenAlexPaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: {
		identifiers: readonly PaperIdentifier[];
		processingId: string;
	},
) {
	if (candidate.identifiers.length === 0) return { contentPdfUrl: null, identifiers: [], metadata: null };
	const attemptStartedAt = Date.now();
	try {
		const resolved = await step.do(
			'resolve-paper-openalex-with-citations-v4',
			{ retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const paper = await resolveOpenAlexPaper({
					apiKey: env.OPENALEX_API_KEY,
					identifiers: candidate.identifiers,
				});
				console.info({
					tag: 'PAPER_PROVIDER',
					event: 'academic_enrichment',
					provider: 'openalex',
					processing_id: candidate.processingId,
					identity_schemes: [...new Set(candidate.identifiers.map(({ scheme }) => scheme))],
					outcome: paper ? 'resolved' : 'not_found',
					latency_ms: Date.now() - startedAt,
				});
				return paper;
			},
		);
		return {
			contentPdfUrl: resolved?.contentPdfUrl ?? null,
			identifiers: resolved?.identifiers ?? [...candidate.identifiers],
			metadata: resolved?.metadata ?? null,
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
		return { contentPdfUrl: null, identifiers: [], metadata: null };
	}
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
	const citoidIdentifiers = candidate.citoidUrl
		? await stageCitoidPaperIdentifiers(step, { citoidUrl: candidate.citoidUrl, processingId: candidate.processingId })
		: [];
	return stageOpenAlexPaperEnrichment(env, step, {
		identifiers: choosePreferredIdentifiers([...candidate.identifiers, ...citoidIdentifiers]),
		processingId: candidate.processingId,
	});
}

type PdfRepresentation = Readonly<{
	fileType: typeof PDF_MIME;
	markdown: string;
	paperIdentifierText: string | null;
}>;

async function stageOpenAlexPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		contentPdfUrl: string;
		processingId: string;
		workflow: PdfWorkflowIdentity;
	},
): Promise<PdfRepresentation | null> {
	let local: LocalPdfAcquisition;
	try {
		const contentStream = await step.do(
			'acquire-openalex-content-pdf-v5',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const response = await fetchOpenAlexPdf({ apiKey: env.OPENALEX_API_KEY, contentPdfUrl: input.contentPdfUrl });
				return Response.json(await acquireFetchedPdfResponse(response, input.contentPdfUrl)).body!;
			},
		);
		local = await new Response(contentStream).json<LocalPdfAcquisition>();
	} catch (error) {
		console.error({
			tag: 'OPENALEX_CONTENT',
			event: 'pdf_acquisition_failed',
			processing_id: input.processingId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
	const acquired = await resolvePublicPdfAcquisition(env, step, {
		local,
		processingId: input.processingId,
		source: { kind: 'openalex', url: input.contentPdfUrl },
		summary: 'preserve',
		workflow: input.workflow,
	});
	console.info({
		tag: 'OPENALEX_CONTENT',
		event: 'pdf_acquired',
		processing_id: input.processingId,
		chars: acquired.markdown.length,
		local_parse_outcome: local.parse.status,
	});
	return {
		fileType: PDF_MIME,
		markdown: acquired.markdown,
		paperIdentifierText: acquired.paperIdentifierText ?? null,
	};
}

export async function stagePaperProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquiredContent: GenericAcquiredMaterial;
		allowProviderPdfFallback: boolean;
		canonicalUrl: string | null;
		processingId: string;
		publishedDate: string | null;
		seedIdentifiers: readonly PaperIdentifier[];
		sourceUrl: string | null;
		allowCitoidLookup: boolean;
		workflow: PdfWorkflowIdentity;
	},
) {
	const identifiers = localPaperIdentifiers({
		canonicalUrl: input.canonicalUrl,
		documentTitle: input.acquiredContent.fileType === PDF_MIME ? input.acquiredContent.title : null,
		identifierText: input.acquiredContent.fileType === PDF_MIME ? (input.acquiredContent.paperIdentifierText ?? null) : null,
		seedIdentifiers: input.seedIdentifiers,
		sourceUrl: input.sourceUrl,
	});
	const resolution = await stagePaperEnrichment(env, step, {
		citoidUrl: identifiers.length || !input.allowCitoidLookup ? null : input.canonicalUrl,
		identifiers,
		processingId: input.processingId,
	});
	const enriched = applyPaperMetadata(input.acquiredContent, resolution.metadata, input.publishedDate);
	const pdfRepresentation =
		input.acquiredContent.fileType === PDF_MIME || !resolution.contentPdfUrl || !input.allowProviderPdfFallback
			? null
			: await stageOpenAlexPdfAcquisition(env, step, {
					contentPdfUrl: resolution.contentPdfUrl,
					processingId: input.processingId,
					workflow: input.workflow,
				});
	const acquiredContent = pdfRepresentation
		? {
				...enriched.acquiredContent,
				...pdfRepresentation,
				source: enriched.acquiredContent.source.trim() || (input.canonicalUrl ? new URL(input.canonicalUrl).hostname : 'OpenAlex'),
			}
		: enriched.acquiredContent;
	const resourceIdentifiers = choosePreferredIdentifiers([...identifiers, ...resolution.identifiers]);
	return { acquiredContent, publishedDate: enriched.publishedDate, resourceIdentifiers };
}
