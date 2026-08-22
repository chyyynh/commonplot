// Provider-independent bibliographic resolution followed by OpenAlex enrichment.

import type { WorkflowDynamicDelayContext, WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import {
	canonicalPaperUrl,
	type PaperIdentifier,
	paperIdentityFromIdentifiers,
	paperIdentityFromText,
	resolveExactPaperInput,
} from '@core-shared/paper-identity';
import { isPaperIdentifier } from '@core-shared/resource-identifiers';
import { literalCreator, type PaperKindMetadata } from '@core-shared/resource-metadata';
import type { PaperMetadata, ResolvedResource, ResourceForProcessing } from '@core-shared/types';
import { resolveBibliographicIdentifiers } from './bibliographic-resolver';
import { resolveOpenAlexPaper } from './openalex';

const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 15;
const MAX_RATE_LIMIT_DELAY_SECONDS = 5 * 60;
const IDENTIFIER_SCAN_CHARS = 3_000;
type PaperEnrichmentCandidate = Pick<ResourceForProcessing, 'processing_id' | 'url' | 'scope' | 'source_id' | 'resource_platform'> & {
	identifierText?: string | null;
	identifiers?: readonly PaperIdentifier[];
	translateUrl?: boolean;
};

export type PaperEnrichmentResolution = {
	contentGrobidXmlUrl: string | null;
	contentPdfUrl: string | null;
	identifiers: PaperIdentifier[];
	metadata: PaperMetadata | null;
};

function isExplicitPaperUrl(url: string | null | undefined): boolean {
	return resolveExactPaperInput(url) !== null;
}

/** OpenAlex fields become canonical once academic enrichment resolves the work. */
export function applyPaperEnrichment(resource: ResolvedResource, metadata: PaperMetadata | null): ResolvedResource {
	if (!metadata) return resource;

	let publishedDate = resource.published_date;
	if (!publishedDate && metadata.publicationDate) {
		const candidate = new Date(`${metadata.publicationDate}T00:00:00.000Z`);
		if (!Number.isNaN(candidate.getTime())) publishedDate = candidate.toISOString();
	}
	const abstract = metadata.abstract?.trim();
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
		...resource,
		...(abstract ? { summary: abstract } : {}),
		published_date: publishedDate,
		creators: metadata.authors.flatMap((author) => literalCreator('author', author)),
		kind_metadata: kindMetadata,
	};
}

function localPaperEvidence(candidate: PaperEnrichmentCandidate): boolean {
	if (candidate.resource_platform !== null) return false;
	return (
		isExplicitPaperUrl(candidate.url) ||
		!!paperIdentityFromText(candidate.identifierText?.slice(0, IDENTIFIER_SCAN_CHARS)) ||
		!!candidate.identifiers?.length
	);
}

function shouldTranslateSavedUrl(candidate: PaperEnrichmentCandidate): boolean {
	return (
		candidate.translateUrl === true ||
		(candidate.scope === 'corpus' && candidate.source_id == null && candidate.resource_platform == null && !!candidate.url?.trim())
	);
}

function paperEnrichmentRetryDelay({ ctx, error }: WorkflowDynamicDelayContext): WorkflowSleepDuration {
	const requestedDelay = error.message.match(/retry_after_seconds=(\d+)/)?.[1];
	if (requestedDelay) {
		const seconds = Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(1, Number(requestedDelay)));
		return `${seconds} seconds`;
	}
	if (error.message.includes('HTTP 429')) {
		return `${Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, ctx.attempt * DEFAULT_RATE_LIMIT_DELAY_SECONDS)} seconds`;
	}
	return `${Math.min(30, ctx.attempt * 5)} seconds`;
}

export async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: PaperEnrichmentCandidate,
): Promise<PaperEnrichmentResolution> {
	const hasLocalPaperEvidence = localPaperEvidence(candidate);
	const translateSavedUrl = !hasLocalPaperEvidence && shouldTranslateSavedUrl(candidate);
	if (!hasLocalPaperEvidence && !translateSavedUrl) {
		return { contentGrobidXmlUrl: null, contentPdfUrl: null, identifiers: [], metadata: null };
	}
	const attemptStartedAt = Date.now();

	try {
		const resolution = await step.do(
			'resolve-paper-openalex-with-citations-v2',
			{ retries: { limit: 5, delay: paperEnrichmentRetryDelay }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const bibliographic = await resolveBibliographicIdentifiers({
					identifierText: candidate.identifierText,
					seedIdentifiers: candidate.identifiers,
					url: candidate.url,
					translateUrl: translateSavedUrl,
				});
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
					processing_id: candidate.processing_id,
					identity_schemes: [...new Set(bibliographic.map(({ scheme }) => scheme))],
					outcome: paper ? 'resolved' : 'not_found',
					latency_ms: Date.now() - startedAt,
				});
				return { identifiers: bibliographic, resolved };
			},
		);
		return {
			contentGrobidXmlUrl: resolution?.resolved?.contentGrobidXmlUrl ?? null,
			contentPdfUrl: resolution?.resolved?.contentPdfUrl ?? null,
			identifiers: resolution?.resolved?.identifiers ?? resolution?.identifiers ?? [],
			metadata: resolution?.resolved?.metadata ?? null,
		};
	} catch (error) {
		console.warn({
			tag: 'PAPER_PROVIDER',
			event: 'academic_enrichment',
			processing_id: candidate.processing_id,
			outcome: 'failed',
			latency_ms: Date.now() - attemptStartedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			contentGrobidXmlUrl: null,
			contentPdfUrl: null,
			identifiers: [],
			metadata: null,
		};
	}
}

export function privatePaperAttachment(resource: ResourceForProcessing): { canonicalUrl: string } | null {
	if (resource.scope !== 'private' || !resource.storage_key) return null;
	const identity = paperIdentityFromIdentifiers(resource.resource_identifiers.filter(isPaperIdentifier));
	if (!identity) throw new Error(`Private paper processing ${resource.processing_id} has no canonical identity`);
	return { canonicalUrl: canonicalPaperUrl(identity) };
}
