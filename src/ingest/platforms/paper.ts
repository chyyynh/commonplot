// Exact-identifier academic enrichment. OpenAlex is primary when configured;
// Semantic Scholar remains a metadata fallback.

import type { WorkflowDynamicDelayContext, WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import { normalizeArxivId, type PaperIdentity, paperIdentityFromText, resolveExactPaperInput } from '@core-shared/paper-identity';
import type { PaperMetadata, PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { z } from 'zod';
import { resolveOpenAlexPaper } from './openalex';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 15;
const MAX_RATE_LIMIT_DELAY_SECONDS = 5 * 60;
// A paper prints its own identifiers in the front matter. Deeper in, every DOI
// and arXiv id belongs to a work it cites, so scanning the whole body would
// cheerfully identify a paper as one of its own references.
const IDENTIFIER_SCAN_CHARS = 3_000;
const PAPER_FIELDS = [
	'title',
	'year',
	'publicationDate',
	'abstract',
	'venue',
	'citationCount',
	'referenceCount',
	'openAccessPdf',
	'externalIds',
	'authors.name',
].join(',');

type PaperId =
	| { kind: 'doi'; value: string }
	| { kind: 'arxiv'; value: string; versionedValue: string }
	| { kind: 'openalex'; value: string };
type PaperEnrichmentCandidate = {
	id: string;
	url?: string | null;
	content?: string | null;
	platform_metadata?: Pick<PlatformMetadata, 'enrichments'>;
	hasExistingAcademic?: boolean;
};

type PaperEnrichmentAttempt = {
	metadata: PaperMetadata | null;
	outcome: 'resolved' | 'preserved' | 'not_found' | 'failed' | 'not_applicable';
};

const S2AuthorSchema = z.object({ name: z.string().nullish() });
const S2ExternalIdsSchema = z.object({ ArXiv: z.string().nullish(), DOI: z.string().nullish() });
const S2PaperSchema = z.object({
	paperId: z.string().nullish(),
	title: z.string().nullish(),
	year: z.number().int().nullish(),
	publicationDate: z.string().nullish(),
	abstract: z.string().nullish(),
	venue: z.string().nullish(),
	citationCount: z.number().int().nonnegative().nullish(),
	referenceCount: z.number().int().nonnegative().nullish(),
	openAccessPdf: z.object({ url: z.string().nullish() }).nullish(),
	externalIds: S2ExternalIdsSchema.nullish(),
	authors: z.array(S2AuthorSchema).nullish(),
});

type S2Author = z.infer<typeof S2AuthorSchema>;
type S2Paper = z.infer<typeof S2PaperSchema>;

function detectPaperId(url: string | null | undefined): PaperId | null {
	const resolved = resolveExactPaperInput(url);
	if (resolved?.identity.arxivId) {
		return {
			kind: 'arxiv',
			value: resolved.identity.arxivId,
			versionedValue: resolved.identity.arxivId,
		};
	}
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
	if (identity?.arxivId) {
		return { kind: 'arxiv', value: identity.arxivId, versionedValue: identity.arxivId };
	}
	return null;
}

export function isExplicitPaperUrl(url: string | null | undefined): boolean {
	return detectPaperId(url) !== null;
}

async function fetchS2Json(path: string, apiKey?: string): Promise<unknown | null> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers['x-api-key'] = apiKey;
	const res = await fetchWithTimeout(`${S2_BASE}${path}`, { headers }, REQUEST_TIMEOUT_MS);
	if (res.ok) return JSON.parse(await readTextWithLimit(res, RESPONSE_MAX_BYTES));
	const status = res.status;
	const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get('retry-after'));
	await res.body?.cancel();
	if (status === 404) return null;
	if (status === 429) {
		throw new Error(
			retryAfterSeconds === null
				? 'Semantic Scholar request failed with HTTP 429'
				: `Semantic Scholar request failed with HTTP 429; retry_after_seconds=${retryAfterSeconds}`,
		);
	}
	throw new Error(`Semantic Scholar request failed with HTTP ${status}`);
}

async function fetchS2Paper(path: string, apiKey?: string): Promise<S2Paper | null> {
	const json = await fetchS2Json(path, apiKey);
	return json === null ? null : S2PaperSchema.parse(json);
}

function parseRetryAfterSeconds(value: string | null): number | null {
	if (!value?.trim()) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(1, Math.ceil(seconds)));
	}
	const retryAt = Date.parse(value);
	if (Number.isNaN(retryAt)) return null;
	return Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)));
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

function authorNames(authors: S2Author[] | null | undefined): string[] {
	if (!authors) return [];
	return authors.map((a) => a.name).filter((name): name is string => !!name);
}

function normalizePublicationDate(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
	const parsed = new Date(`${trimmed}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed ? undefined : trimmed;
}

function normalizeHttpsUrl(value: string | null | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function paperPdfUrl(id: PaperId, paper: S2Paper): string | undefined {
	if (id.kind === 'arxiv') return `https://arxiv.org/pdf/${id.versionedValue}`;
	return normalizeHttpsUrl(paper.openAccessPdf?.url);
}

function normalizePaper(id: PaperId, paper: S2Paper): PaperMetadata {
	const doi = paper.externalIds?.DOI?.toLowerCase();
	const arxivId = normalizeArxivId(paper.externalIds?.ArXiv) ?? (id.kind === 'arxiv' ? id.value : undefined);
	const fetchedAt = new Date().toISOString();
	return {
		schemaVersion: 2,
		source: 'semanticscholar',
		resolvedAt: fetchedAt,
		metricsUpdatedAt: fetchedAt,
		doi,
		...(arxivId ? { arxivId } : {}),
		title: paper.title ?? undefined,
		authors: authorNames(paper.authors),
		abstract: paper.abstract ?? undefined,
		venue: paper.venue ?? undefined,
		year: paper.year ?? undefined,
		publicationDate: normalizePublicationDate(paper.publicationDate),
		citedByCount: paper.citationCount ?? undefined,
		referenceCount: paper.referenceCount ?? undefined,
		pdfUrl: paperPdfUrl(id, paper),
	};
}

function idPath(id: PaperId): string {
	if (id.kind === 'doi') return `DOI:${id.value}`;
	if (id.kind === 'arxiv') return `ARXIV:${id.value}`;
	return id.value;
}

/** Resolve a paper by DOI or arXiv id. Returns null when Semantic Scholar has no match. */
async function enrichS2FromId(id: PaperId, apiKey?: string): Promise<PaperMetadata | null> {
	if (id.kind === 'openalex') return null;
	const paper = await fetchS2Paper(`/paper/${idPath(id)}?fields=${PAPER_FIELDS}`, apiKey);
	if (!paper?.paperId) return null;
	return normalizePaper(id, paper);
}

export async function stagePaperEnrichmentAttempt(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: PaperEnrichmentCandidate,
	stepName = 'enrich-paper-metadata',
): Promise<PaperEnrichmentAttempt> {
	const paperId = detectPaperIdentity({ text: candidate.content, url: candidate.url });
	if (!paperId) return { metadata: null, outcome: 'not_applicable' };
	const hasExistingAcademic = candidate.hasExistingAcademic ?? !!candidate.platform_metadata?.enrichments?.academic;
	const attemptStartedAt = Date.now();

	try {
		const metadata = await step.do(
			stepName,
			{ retries: { limit: 5, delay: paperEnrichmentRetryDelay }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const openAlexPaper = await resolveOpenAlexPaper({
					apiKey: env.OPENALEX_API_KEY,
					identity: providerIdentity(paperId),
				});
				const paper = openAlexPaper ?? (await enrichS2FromId(paperId, env.S2_API_KEY));
				console.info({
					tag: 'PAPER_PROVIDER',
					event: 'academic_enrichment',
					provider: paper?.source ?? (env.OPENALEX_API_KEY ? 'openalex_then_semanticscholar' : 'semanticscholar'),
					resource_id: candidate.id,
					identity_kind: paperId.kind,
					outcome: paper ? 'resolved' : hasExistingAcademic ? 'preserved' : 'not_found',
					latency_ms: Date.now() - startedAt,
				});
				return paper;
			},
		);
		return {
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
		return { metadata: null, outcome: hasExistingAcademic ? 'preserved' : 'failed' };
	}
}

export async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: Pick<ResourceForProcessing, 'id' | 'platform_metadata' | 'url' | 'content'>,
): Promise<PaperMetadata | null> {
	return (await stagePaperEnrichmentAttempt(env, step, candidate)).metadata;
}
