// Exact-identifier academic enrichment through OpenAlex.

import type { WorkflowDynamicDelayContext, WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { type PaperIdentity, paperIdentityFromText, resolveExactPaperInput } from '@core-shared/paper-identity';
import type { PaperMetadata, PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { resolveOpenAlexPaper } from './openalex';

const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 15;
const MAX_RATE_LIMIT_DELAY_SECONDS = 5 * 60;
// A paper prints its own identifiers in the front matter. Deeper in, every DOI
// and arXiv id belongs to a work it cites, so scanning the whole body would
// cheerfully identify a paper as one of its own references.
const IDENTIFIER_SCAN_CHARS = 3_000;
type PaperId = { kind: 'doi' | 'arxiv' | 'openalex'; value: string };
type PaperEnrichmentCandidate = {
	id: string;
	url?: string | null;
	content?: string | null;
	platform_metadata?: Pick<PlatformMetadata, 'enrichments'>;
	hasExistingAcademic?: boolean;
};

type PaperEnrichmentAttempt = {
	contentPdfUrl: string | null;
	metadata: PaperMetadata | null;
	outcome: 'resolved' | 'preserved' | 'not_found' | 'failed' | 'not_applicable';
};

function detectPaperId(url: string | null | undefined): PaperId | null {
	const resolved = resolveExactPaperInput(url);
	if (resolved?.identity.arxivId) return { kind: 'arxiv', value: resolved.identity.arxivId };
	if (resolved?.identity.doi) return { kind: 'doi', value: resolved.identity.doi };
	return resolved?.identity.openAlexId ? { kind: 'openalex', value: resolved.identity.openAlexId } : null;
}

function providerIdentity(id: PaperId): PaperIdentity {
	if (id.kind === 'doi') return { doi: id.value };
	if (id.kind === 'arxiv') return { arxivId: id.value };
	return { openAlexId: id.value };
}

/**
 * The single identity ladder every entry point shares. A saved URL carries the
 * identity outright; an uploaded file has to give it up from its own bounded
 * front matter. Similar titles never establish canonical identity.
 */
function detectPaperIdentity(input: { url?: string | null; text?: string | null }): PaperId | null {
	const fromUrl = detectPaperId(input.url);
	if (fromUrl) return fromUrl;
	const head = input.text?.slice(0, IDENTIFIER_SCAN_CHARS);
	if (!head) return null;
	const identity = paperIdentityFromText(head);
	if (identity?.doi) return { kind: 'doi', value: identity.doi };
	if (identity?.arxivId) return { kind: 'arxiv', value: identity.arxivId };
	return null;
}

export function isExplicitPaperUrl(url: string | null | undefined): boolean {
	return detectPaperId(url) !== null;
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
	stepName = 'enrich-paper-metadata',
): Promise<PaperEnrichmentAttempt> {
	const paperId = detectPaperIdentity({ text: candidate.content, url: candidate.url });
	if (!paperId) return { contentPdfUrl: null, metadata: null, outcome: 'not_applicable' };
	const hasExistingAcademic = candidate.hasExistingAcademic ?? !!candidate.platform_metadata?.enrichments?.academic;
	const attemptStartedAt = Date.now();

	try {
		const resolution = await step.do(
			stepName,
			{ retries: { limit: 5, delay: paperEnrichmentRetryDelay }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const resolved = await resolveOpenAlexPaper({
					apiKey: env.OPENALEX_API_KEY,
					identity: providerIdentity(paperId),
				});
				const paper = resolved?.metadata ?? null;
				console.info({
					tag: 'PAPER_PROVIDER',
					event: 'academic_enrichment',
					provider: 'openalex',
					resource_id: candidate.id,
					identity_kind: paperId.kind,
					outcome: paper ? 'resolved' : hasExistingAcademic ? 'preserved' : 'not_found',
					latency_ms: Date.now() - startedAt,
				});
				return resolved;
			},
		);
		const metadata = resolution?.metadata ?? null;
		return {
			contentPdfUrl: resolution?.contentPdfUrl ?? null,
			metadata,
			outcome: metadata ? 'resolved' : hasExistingAcademic ? 'preserved' : 'not_found',
		};
	} catch (error) {
		console.warn({
			tag: 'PAPER_PROVIDER',
			event: 'academic_enrichment',
			resource_id: candidate.id,
			identity_kind: paperId.kind,
			outcome: hasExistingAcademic ? 'preserved' : 'failed',
			latency_ms: Date.now() - attemptStartedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		return { contentPdfUrl: null, metadata: null, outcome: hasExistingAcademic ? 'preserved' : 'failed' };
	}
}

export async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: Pick<ResourceForProcessing, 'id' | 'platform_metadata' | 'url' | 'content'>,
	stepName?: string,
): Promise<Pick<PaperEnrichmentAttempt, 'contentPdfUrl' | 'metadata'>> {
	const { contentPdfUrl, metadata } = await stagePaperEnrichmentAttempt(env, step, candidate, stepName);
	return { contentPdfUrl, metadata };
}
