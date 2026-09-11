// Provider-independent bibliographic resolution followed by OpenAlex enrichment.

import type { WorkflowStep } from 'cloudflare:workers';
import {
	canonicalPaperUrl,
	normalizePaperIdentifiers,
	type PaperIdentifier,
	paperIdentifiersFromIdentity,
	paperIdentityFromIdentifiers,
	paperIdentityFromText,
	resolveExactPaperInput,
} from '../../shared/paper-identity';
import type { AcquiredResource } from '../../shared/resource';
import { resolveCrossrefPaper } from '../crossref';
import { resolveOpenAlexPaper } from './openalex';
import { PDF_MIME, stageOpenAlexPdfMarkdown } from './pdf';

const ARXIV_DOI_PREFIX = '10.48550/arxiv.';

function choosePreferredIdentifiers(identifiers: readonly PaperIdentifier[]): PaperIdentifier[] {
	const normalized = normalizePaperIdentifiers(identifiers.map((identifier) => ({ ...identifier, preferred: false })));
	const preferredDoi = normalized.find((identifier) => identifier.scheme === 'doi' && !identifier.value.startsWith(ARXIV_DOI_PREFIX));
	if (!preferredDoi) return normalized;
	return normalized.map((identifier) =>
		identifier.scheme === 'doi' ? { ...identifier, preferred: identifier.value === preferredDoi.value } : identifier,
	);
}

async function stageOpenAlexPaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: {
		identifiers: readonly PaperIdentifier[];
		processingId: string;
	},
) {
	if (candidate.identifiers.length === 0) return null;
	const attemptStartedAt = Date.now();
	try {
		return await step.do(
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
	} catch (error) {
		console.warn({
			tag: 'PAPER_PROVIDER',
			event: 'academic_enrichment',
			processing_id: candidate.processingId,
			outcome: 'failed',
			latency_ms: Date.now() - attemptStartedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function stageCrossrefPaperEnrichment(
	step: WorkflowStep,
	candidate: {
		doi: string;
		processingId: string;
	},
) {
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
	const openAlex =
		resource.fileType === PDF_MIME
			? null
			: await stageOpenAlexPaperEnrichment(env, step, { identifiers, processingId: input.processingId });
	const doi = paperIdentityFromIdentifiers(identifiers)?.doi;
	const crossref =
		resource.fileType === PDF_MIME && doi ? await stageCrossrefPaperEnrichment(step, { doi, processingId: input.processingId }) : null;
	const { abstract, authors, publicationDate, title, ...kindMetadata } = { ...openAlex?.metadata, ...crossref };
	const pdfMarkdown = openAlex?.contentPdfUrl
		? await stageOpenAlexPdfMarkdown(env, step, { contentPdfUrl: openAlex.contentPdfUrl, processingId: input.processingId })
		: null;
	const content = pdfMarkdown ?? resource.content;
	if (!content.trim()) throw new Error(`Processing ${input.processingId} has no extractable content`);
	const resourceIdentifiers = choosePreferredIdentifiers([...identifiers, ...(openAlex?.identifiers ?? [])]);
	const identity = paperIdentityFromIdentifiers(resourceIdentifiers);
	if (!identity) return resource;
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
		creators: authors
			? authors
					.map((author) => author.trim())
					.filter(Boolean)
					.map((literal) => ({ role: 'author', literal }))
			: resource.creators,
		kindMetadata,
		fileType: pdfMarkdown ? PDF_MIME : resource.fileType,
	} satisfies AcquiredResource;
}
