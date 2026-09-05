// Provider-independent bibliographic resolution followed by OpenAlex enrichment.

import type { WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import {
	canonicalPaperUrl,
	normalizePaperIdentifiers,
	type PaperIdentifier,
	paperIdentifiersFromIdentity,
	paperIdentityFromIdentifiers,
	paperIdentityFromText,
	resolveExactPaperInput,
} from '../../shared/paper-identity';
import { type AcquiredResource, literalCreator } from '../../shared/resource';
import { resolveCrossrefPaper } from '../crossref';
import { type PaperMetadata, resolveOpenAlexPaper } from './openalex';
import { PDF_MIME, stageOpenAlexPdfMarkdown } from './pdf';

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

function choosePreferredIdentifiers(identifiers: readonly PaperIdentifier[]): PaperIdentifier[] {
	const normalized = normalizePaperIdentifiers(identifiers.map((identifier) => ({ ...identifier, preferred: false })));
	const preferredDoi = normalized.find((identifier) => identifier.scheme === 'doi' && !identifier.value.startsWith(ARXIV_DOI_PREFIX));
	if (!preferredDoi) return normalized;
	return normalized.map((identifier) =>
		identifier.scheme === 'doi' ? { ...identifier, preferred: identifier.value === preferredDoi.value } : identifier,
	);
}

async function resolveCitoidPaperIdentifiers(value: string): Promise<PaperIdentifier[]> {
	const parsedUrl = URL.parse(value);
	if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.username || parsedUrl.password) {
		return [];
	}
	const response = await fetch(`${CITOID_BASE}${encodeURIComponent(parsedUrl.toString())}`, {
		headers: { Accept: 'application/json', 'Api-User-Agent': CITOID_USER_AGENT, 'User-Agent': CITOID_USER_AGENT },
		signal: AbortSignal.timeout(CITOID_TIMEOUT_MS),
	});
	if (!response.ok) {
		const retryAfter = response.headers.get('retry-after');
		await response.body?.cancel();
		if (response.status === 429) {
			throw new Error(`Citoid request failed with HTTP 429${retryAfter ? `; retry_after_seconds=${retryAfter}` : ''}`);
		}
		console.warn({ tag: 'CITOID', event: 'lookup_unavailable', status: response.status });
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

async function stageCrossrefPaperEnrichment(
	step: WorkflowStep,
	candidate: {
		doi: string;
		processingId: string;
	},
): Promise<PaperMetadata | null> {
	const attemptStartedAt = Date.now();
	try {
		return await step.do(
			'resolve-pdf-paper-crossref-by-doi-v1',
			{ retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const metadata = await resolveCrossrefPaper(candidate.doi);
				console.info({
					tag: 'PAPER_PROVIDER',
					event: 'academic_enrichment',
					provider: 'crossref',
					processing_id: candidate.processingId,
					identity_schemes: ['doi'],
					outcome: metadata ? 'resolved' : 'not_found',
					latency_ms: Date.now() - startedAt,
				});
				return metadata;
			},
		);
	} catch (error) {
		console.warn({
			tag: 'PAPER_PROVIDER',
			event: 'academic_enrichment',
			provider: 'crossref',
			processing_id: candidate.processingId,
			outcome: 'failed',
			latency_ms: Date.now() - attemptStartedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export async function stagePaperResolution(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		resource: AcquiredResource & { resourcePlatform: null; paperIdentifierText?: string | null };
		processingId: string;
		seedIdentifiers: readonly PaperIdentifier[];
		sourceUrl: string | null;
		allowCitoidLookup: boolean;
	},
) {
	const { paperIdentifierText, ...resource } = input.resource;
	const canonicalUrl = resource.url;
	const exactIdentifiers = [input.sourceUrl, canonicalUrl === input.sourceUrl ? null : canonicalUrl].flatMap((value) => {
		const resolved = resolveExactPaperInput(value);
		return resolved ? paperIdentifiersFromIdentity(resolved.identity) : [];
	});
	const textIdentity = resource.fileType === PDF_MIME && paperIdentifierText?.trim() ? paperIdentityFromText(paperIdentifierText) : null;
	const identifiers = choosePreferredIdentifiers([
		...exactIdentifiers,
		...(textIdentity ? paperIdentifiersFromIdentity(textIdentity) : []),
		...input.seedIdentifiers,
	]);
	const doi = paperIdentityFromIdentifiers(identifiers)?.doi;
	const citoidIdentifiers =
		resource.fileType !== PDF_MIME && !identifiers.length && input.allowCitoidLookup && canonicalUrl
			? await stageCitoidPaperIdentifiers(step, { citoidUrl: canonicalUrl, processingId: input.processingId })
			: [];
	const resolution =
		resource.fileType === PDF_MIME
			? {
					contentPdfUrl: null,
					identifiers,
					metadata: doi ? await stageCrossrefPaperEnrichment(step, { doi, processingId: input.processingId }) : null,
				}
			: await stageOpenAlexPaperEnrichment(env, step, {
					identifiers: choosePreferredIdentifiers([...identifiers, ...citoidIdentifiers]),
					processingId: input.processingId,
				});
	const pdfMarkdown =
		resource.fileType === PDF_MIME || !resolution.contentPdfUrl
			? null
			: await stageOpenAlexPdfMarkdown(env, step, {
					contentPdfUrl: resolution.contentPdfUrl,
					processingId: input.processingId,
				});
	const content = pdfMarkdown ?? resource.content;
	if (!content.trim()) throw new Error(`Processing ${input.processingId} has no extractable content`);
	const resourceIdentifiers = choosePreferredIdentifiers([...identifiers, ...resolution.identifiers]);
	const identity = paperIdentityFromIdentifiers(resourceIdentifiers);
	if (!identity) return resource;
	const { abstract, authors, publicationDate, title, ...kindMetadata } = resolution.metadata ?? {};
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
		source: pdfMarkdown ? resource.source.trim() || (canonicalUrl ? new URL(canonicalUrl).hostname : 'OpenAlex') : resource.source,
		publishedDate,
		creators: authors ? authors.flatMap((author) => literalCreator('author', author)) : resource.creators,
		kindMetadata,
		fileType: pdfMarkdown ? PDF_MIME : resource.fileType,
	} satisfies AcquiredResource;
}
