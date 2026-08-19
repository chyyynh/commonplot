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
import { literalCreator, type PaperKindMetadata, type ResourceCreator } from '@core-shared/resource-metadata';
import type { PaperMetadata, ResourceForProcessing } from '@core-shared/types';
import { resolveBibliographicIdentifiers } from './bibliographic-resolver';
import { resolveOpenAlexPaper } from './openalex';

const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 15;
const MAX_RATE_LIMIT_DELAY_SECONDS = 5 * 60;
const IDENTIFIER_SCAN_CHARS = 3_000;
type PaperEnrichmentCandidate = Pick<ResourceForProcessing, 'id' | 'url' | 'scope' | 'source_id' | 'resource_platform'> & {
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

export function isExplicitPaperUrl(url: string | null | undefined): boolean {
	return resolveExactPaperInput(url) !== null;
}

function localPaperEvidence(candidate: PaperEnrichmentCandidate): boolean {
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
	options: { stepName?: string } = {},
): Promise<PaperEnrichmentResolution> {
	const hasLocalPaperEvidence = localPaperEvidence(candidate);
	const translateSavedUrl = !hasLocalPaperEvidence && shouldTranslateSavedUrl(candidate);
	if (!hasLocalPaperEvidence && !translateSavedUrl) {
		return { contentGrobidXmlUrl: null, contentPdfUrl: null, identifiers: [], metadata: null };
	}
	const attemptStartedAt = Date.now();

	try {
		const resolution = await step.do(
			options.stepName ?? 'enrich-paper-metadata',
			{ retries: { limit: 5, delay: paperEnrichmentRetryDelay }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const bibliographic = await resolveBibliographicIdentifiers({
					identifierText: candidate.identifierText,
					seedIdentifiers: candidate.identifiers,
					url: candidate.url,
					translateUrl: translateSavedUrl,
				});
				if (bibliographic.identifiers.length === 0) {
					return null;
				}
				const resolved = await resolveOpenAlexPaper({
					apiKey: env.OPENALEX_API_KEY,
					identifiers: bibliographic.identifiers,
				});
				const paper = resolved?.metadata ?? null;
				console.info({
					tag: 'PAPER_PROVIDER',
					event: 'academic_enrichment',
					provider: 'openalex',
					resource_id: candidate.id,
					identity_schemes: [...new Set(bibliographic.identifiers.map(({ scheme }) => scheme))],
					outcome: paper ? 'resolved' : 'not_found',
					latency_ms: Date.now() - startedAt,
				});
				return { ...bibliographic, resolved };
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
			resource_id: candidate.id,
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

function paperCanonicalFields(metadata: PaperMetadata): {
	creators: ResourceCreator[];
	kindMetadata: PaperKindMetadata;
} {
	return {
		creators: metadata.authors.flatMap((author) => literalCreator('author', author)),
		kindMetadata: {
			...(metadata.venue?.trim() ? { venue: metadata.venue.trim() } : {}),
			...(metadata.year === undefined ? {} : { year: metadata.year }),
			...(metadata.citedByCount === undefined ? {} : { citedByCount: metadata.citedByCount }),
			...(metadata.referenceCount === undefined ? {} : { referenceCount: metadata.referenceCount }),
			...(metadata.pdfUrl?.trim() ? { pdfUrl: metadata.pdfUrl.trim() } : {}),
			...(metadata.references ? { references: metadata.references } : {}),
			...(metadata.citations ? { citations: metadata.citations } : {}),
		},
	};
}

function withAcademicPublishedDate(resource: ResourceForProcessing, paper: PaperMetadata | null): ResourceForProcessing {
	if (resource.published_date || !paper?.publicationDate) return resource;
	const publishedDate = new Date(`${paper.publicationDate}T00:00:00.000Z`);
	return Number.isNaN(publishedDate.getTime()) ? resource : { ...resource, published_date: publishedDate.toISOString() };
}

function withPaperAbstractSummary(resource: ResourceForProcessing, paper: PaperMetadata | null): ResourceForProcessing {
	const abstract = paper?.abstract?.trim();
	return abstract ? { ...resource, summary: abstract } : resource;
}

function withPaperCanonicalFields(resource: ResourceForProcessing, metadata: PaperMetadata | null): ResourceForProcessing {
	if (!metadata) return resource;
	const canonical = paperCanonicalFields(metadata);
	return {
		...resource,
		creators: canonical.creators,
		kind_metadata: canonical.kindMetadata,
	};
}

/** Canonical paper fields win over scraped ones once OpenAlex has resolved the work. */
export function finalizePaperResource(resource: ResourceForProcessing, paper: PaperMetadata | null): ResourceForProcessing {
	return withPaperCanonicalFields(withPaperAbstractSummary(withAcademicPublishedDate(resource, paper), paper), paper);
}

export function privatePaperAttachment(resource: ResourceForProcessing): { canonicalUrl: string } | null {
	if (resource.scope !== 'private' || !resource.storage_key) return null;
	const identity = paperIdentityFromIdentifiers(resource.resource_identifiers.filter(isPaperIdentifier));
	if (!identity) throw new Error(`Private paper ${resource.id} has no canonical identity`);
	return { canonicalUrl: canonicalPaperUrl(identity) };
}
