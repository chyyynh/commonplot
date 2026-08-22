// Provider-independent bibliographic resolution followed by OpenAlex enrichment.

import type { WorkflowStep } from 'cloudflare:workers';
import { type PaperIdentifier, paperIdentityFromText, resolveExactPaperInput } from '@core-shared/paper-identity';
import type { PaperKindMetadata } from '@core-shared/resource';
import { resolveBibliographicIdentifiers } from './bibliographic-resolver';
import { type GenericAcquiredMaterial, literalCreator } from './materialize';
import { acquireOpenAlexGrobidText, acquireOpenAlexPdf, type PaperMetadata, resolveOpenAlexPaper } from './openalex';
import { PDF_MIME } from './pdf';

const IDENTIFIER_SCAN_CHARS = 3_000;
const PAPER_CONTENT_ACQUISITION_STEP = {
	retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
	timeout: '120 seconds',
} as const;
type PaperEnrichmentCandidate = {
	processingId: string;
	url: string | null;
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

type PaperContentCandidate = {
	processingId: string;
	publishedDate: string | null;
	source: string | null;
	summary: string | null;
	title: string;
	url: string | null;
};

function isExplicitPaperUrl(url: string | null | undefined): boolean {
	return resolveExactPaperInput(url) !== null;
}

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
			...(abstract ? { summary: abstract } : {}),
			creators: metadata.authors.flatMap((author) => literalCreator('author', author)),
			kindMetadata,
		},
		publishedDate,
	};
}

function localPaperEvidence(candidate: PaperEnrichmentCandidate): boolean {
	return (
		isExplicitPaperUrl(candidate.url) ||
		!!paperIdentityFromText(candidate.identifierText?.slice(0, IDENTIFIER_SCAN_CHARS)) ||
		!!candidate.identifiers?.length
	);
}

async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: PaperEnrichmentCandidate,
): Promise<PaperEnrichmentResolution> {
	const hasLocalPaperEvidence = localPaperEvidence(candidate);
	const translateSavedUrl = !hasLocalPaperEvidence && candidate.translateUrl === true;
	if (!hasLocalPaperEvidence && !translateSavedUrl) {
		return { contentGrobidXmlUrl: null, contentPdfUrl: null, identifiers: [], metadata: null };
	}
	const attemptStartedAt = Date.now();

	try {
		const resolution = await step.do(
			'resolve-paper-openalex-with-citations-v2',
			{ retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
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
					processing_id: candidate.processingId,
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
			processing_id: candidate.processingId,
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

async function acquireOpenAlexPdfStream(
	input: {
		contentPdfUrl: string;
		description: string | null;
		publishedDate: string | null;
		processingId: string;
		sourceName: string;
		title: string;
	},
	env: CoreEnv,
): Promise<ReadableStream<Uint8Array>> {
	const acquired = await acquireOpenAlexPdf({ apiKey: env.OPENALEX_API_KEY, contentPdfUrl: input.contentPdfUrl });
	const sourceName = input.sourceName.trim();
	if (!sourceName) throw new Error(`Processing ${input.processingId} has no source name for its OpenAlex PDF`);
	return Response.json({
		...acquired,
		title: input.title,
		source: sourceName,
		publishedDate: input.publishedDate,
		summary: input.description,
		kindMetadata: { siteName: sourceName },
	}).body!;
}

async function acquireOpenAlexGrobidStream(
	input: {
		contentGrobidXmlUrl: string;
		description: string | null;
		publishedDate: string | null;
		processingId: string;
		sourceName: string;
		title: string;
	},
	env: CoreEnv,
): Promise<ReadableStream<Uint8Array>> {
	const markdown = await acquireOpenAlexGrobidText({
		contentGrobidXmlUrl: input.contentGrobidXmlUrl,
		env,
		processingId: input.processingId,
	});
	const sourceName = input.sourceName.trim();
	if (!sourceName) throw new Error('OpenAlex GROBID acquisition has no source name');
	return Response.json({
		resourcePlatform: null,
		fileType: null,
		title: input.title,
		markdown,
		source: sourceName,
		originalLang: null,
		publishedDate: input.publishedDate,
		summary: input.description,
		creators: [],
		kindMetadata: { siteName: sourceName },
	}).body!;
}

async function stageOpenAlexContentAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: PaperContentCandidate,
	resolution: PaperEnrichmentResolution,
): Promise<GenericAcquiredMaterial | null> {
	const { contentGrobidXmlUrl, contentPdfUrl, metadata } = resolution;
	if (!contentPdfUrl && !contentGrobidXmlUrl) return null;

	const sourceName = resource.source?.trim() || (resource.url ? new URL(resource.url).hostname : 'OpenAlex');
	const description = metadata?.abstract?.trim() || resource.summary;
	const publishedDate = metadata?.publicationDate?.trim() || resource.publishedDate;
	const title = metadata?.title?.trim() || resource.title;

	if (contentPdfUrl) {
		const contentStream = await step
			.do('acquire-openalex-content-pdf-v2', PAPER_CONTENT_ACQUISITION_STEP, () =>
				acquireOpenAlexPdfStream(
					{ contentPdfUrl, description, publishedDate, processingId: resource.processingId, sourceName, title },
					env,
				),
			)
			.catch((error) => {
				console.error({
					tag: 'OPENALEX_CONTENT',
					event: 'pdf_acquisition_failed',
					processing_id: resource.processingId,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			});
		if (contentStream) {
			const acquired = await new Response(contentStream).json<GenericAcquiredMaterial>();
			console.info({
				tag: 'OPENALEX_CONTENT',
				event: 'pdf_acquired',
				processing_id: resource.processingId,
				chars: acquired.markdown.length,
			});
			return acquired;
		}
	}

	if (contentGrobidXmlUrl) {
		const contentStream = await step
			.do('acquire-openalex-content-grobid-v2', PAPER_CONTENT_ACQUISITION_STEP, () =>
				acquireOpenAlexGrobidStream(
					{ contentGrobidXmlUrl, description, processingId: resource.processingId, publishedDate, sourceName, title },
					env,
				),
			)
			.catch((error) => {
				console.error({
					tag: 'OPENALEX_CONTENT',
					event: 'grobid_acquisition_failed',
					processing_id: resource.processingId,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			});
		if (contentStream) {
			const acquired = await new Response(contentStream).json<GenericAcquiredMaterial>();
			console.info({
				tag: 'OPENALEX_CONTENT',
				event: 'grobid_acquired',
				processing_id: resource.processingId,
				chars: acquired.markdown.length,
			});
			return acquired;
		}
	}

	return null;
}

export async function stagePaperProcessing(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquiredContent: GenericAcquiredMaterial;
		canonicalUrl: string | null;
		identifiers: readonly PaperIdentifier[];
		originSummary: string | null;
		processingId: string;
		publishedDate: string | null;
		translateUrl: boolean;
	},
): Promise<{ acquiredContent: GenericAcquiredMaterial; identifiers: PaperIdentifier[]; publishedDate: string | null }> {
	const resolution = await stagePaperEnrichment(env, step, {
		processingId: input.processingId,
		url: input.canonicalUrl,
		identifierText: input.acquiredContent.fileType === PDF_MIME ? input.acquiredContent.markdown : null,
		identifiers: input.identifiers,
		translateUrl: input.translateUrl,
	});
	const acquiredContent =
		(await stageOpenAlexContentAcquisition(
			env,
			step,
			{
				processingId: input.processingId,
				publishedDate: input.publishedDate,
				source: input.acquiredContent.source,
				summary: input.acquiredContent.summary ?? input.originSummary,
				title: input.acquiredContent.title,
				url: input.canonicalUrl,
			},
			resolution,
		)) ?? input.acquiredContent;
	return { ...applyPaperMetadata(acquiredContent, resolution.metadata, input.publishedDate), identifiers: resolution.identifiers };
}
