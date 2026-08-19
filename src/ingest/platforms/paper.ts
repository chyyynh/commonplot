// Provider-independent bibliographic resolution followed by OpenAlex enrichment.

import type { WorkflowDynamicDelayContext, WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { type PaperIdentifier, paperIdentityFromText, resolveExactPaperInput } from '@core-shared/paper-identity';
import type { PaperMetadata, ResourceForProcessing } from '@core-shared/types';
import { resolveBibliographicIdentifiers } from './bibliographic-resolver';
import { resolveOpenAlexPaper } from './openalex';

const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 15;
const MAX_RATE_LIMIT_DELAY_SECONDS = 5 * 60;
const IDENTIFIER_SCAN_CHARS = 3_000;
type PaperEnrichmentCandidate = {
	id: string;
	url?: string | null;
	identifierText?: string | null;
	scope?: string;
	source_id?: string | null;
	resource_platform?: string | null;
	identifiers?: readonly PaperIdentifier[];
	translateUrl?: boolean;
};

type PaperEnrichmentAttempt = {
	contentGrobidXmlUrl: string | null;
	contentPdfUrl: string | null;
	identifiers: PaperIdentifier[];
	metadata: PaperMetadata | null;
	outcome: 'resolved' | 'preserved' | 'not_found' | 'failed' | 'not_applicable';
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

export async function stagePaperEnrichmentAttempt(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: PaperEnrichmentCandidate,
	options: { includeCitationSnapshots?: boolean; stepName?: string } = {},
): Promise<PaperEnrichmentAttempt> {
	const hasLocalPaperEvidence = localPaperEvidence(candidate);
	const translateSavedUrl = !hasLocalPaperEvidence && shouldTranslateSavedUrl(candidate);
	if (!hasLocalPaperEvidence && !translateSavedUrl) {
		return { contentGrobidXmlUrl: null, contentPdfUrl: null, identifiers: [], metadata: null, outcome: 'not_applicable' };
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
					includeCitationSnapshots: options.includeCitationSnapshots,
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
		const metadata = resolution?.resolved?.metadata ?? null;
		return {
			contentGrobidXmlUrl: resolution?.resolved?.contentGrobidXmlUrl ?? null,
			contentPdfUrl: resolution?.resolved?.contentPdfUrl ?? null,
			identifiers: resolution?.resolved?.identifiers ?? resolution?.identifiers ?? [],
			metadata,
			outcome: metadata ? 'resolved' : 'not_found',
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
			outcome: 'failed',
		};
	}
}

export async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: Pick<ResourceForProcessing, 'id' | 'url' | 'scope' | 'source_id' | 'resource_platform'> & {
		identifierText?: string | null;
		identifiers?: readonly PaperIdentifier[];
		translateUrl?: boolean;
	},
	options?: { includeCitationSnapshots?: boolean; stepName?: string },
): Promise<Pick<PaperEnrichmentAttempt, 'contentGrobidXmlUrl' | 'contentPdfUrl' | 'identifiers' | 'metadata'>> {
	const { contentGrobidXmlUrl, contentPdfUrl, identifiers, metadata } = await stagePaperEnrichmentAttempt(env, step, candidate, options);
	return { contentGrobidXmlUrl, contentPdfUrl, identifiers, metadata };
}
