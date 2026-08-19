// OpenAlex-hosted paper content: cached PDF and GROBID TEI staging for the processing Workflow.

import type { WorkflowStep } from 'cloudflare:workers';
import type { ResourceForProcessing } from '@core-shared/types';
import {
	ACQUISITION_STEP,
	type AcquiredContent,
	acquiredContentArtifact,
	applyAcquiredMaterial,
	readAcquiredContentArtifact,
	sanitizeAcquiredContent,
} from '../acquisition';
import { acquireOpenAlexGrobidText, acquireOpenAlexPdf } from './openalex';
import { isExplicitPaperUrl, type PaperEnrichmentResolution, stagePaperEnrichment } from './paper';

async function acquireOpenAlexPdfArtifact(
	input: {
		contentPdfUrl: string;
		description: string | null;
		publishedDate: string | null;
		resourceId: string;
		sourceName: string;
		title: string;
	},
	env: CoreEnv,
): Promise<ReadableStream<Uint8Array>> {
	const acquired = await acquireOpenAlexPdf({
		apiKey: env.OPENALEX_API_KEY,
		contentPdfUrl: input.contentPdfUrl,
		env,
		resourceId: input.resourceId,
	});
	const sourceName = input.sourceName.trim();
	if (!sourceName) throw new Error(`Resource ${input.resourceId} has no source name for its OpenAlex PDF`);
	return acquiredContentArtifact(
		await sanitizeAcquiredContent({
			...acquired,
			title: input.title,
			metadata: {
				...acquired.metadata,
				description: input.description,
				publishedDate: input.publishedDate,
				siteName: sourceName,
			},
		}),
	);
}

async function acquireOpenAlexGrobidArtifact(
	input: {
		contentGrobidXmlUrl: string;
		description: string | null;
		publishedDate: string | null;
		sourceName: string;
		title: string;
	},
	env: CoreEnv,
): Promise<ReadableStream<Uint8Array>> {
	const markdown = await acquireOpenAlexGrobidText({
		contentGrobidXmlUrl: input.contentGrobidXmlUrl,
		env,
	});
	const sourceName = input.sourceName.trim();
	if (!sourceName) throw new Error('OpenAlex GROBID acquisition has no source name');
	return acquiredContentArtifact(
		await sanitizeAcquiredContent({
			provider: null,
			fileType: null,
			title: input.title,
			markdown,
			metadata: {
				author: null,
				description: input.description,
				language: null,
				publishedDate: input.publishedDate,
				siteName: sourceName,
			},
			acquisition: {
				fetchedAt: new Date().toISOString(),
				data: null,
			},
		}),
	);
}

async function stageOpenAlexPdfAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	resolution: PaperEnrichmentResolution,
	stepName: string,
): Promise<AcquiredContent | null> {
	const { contentPdfUrl, metadata } = resolution;
	if (!contentPdfUrl || resource.scope !== 'corpus' || resource.storage_key) return null;
	const sourceName = resource.source?.trim() || (resource.url ? new URL(resource.url).hostname : 'OpenAlex');
	const artifact = await step
		.do(stepName, ACQUISITION_STEP, () =>
			acquireOpenAlexPdfArtifact(
				{
					contentPdfUrl,
					description: metadata?.abstract?.trim() || resource.summary,
					publishedDate: metadata?.publicationDate?.trim() || resource.published_date,
					resourceId: resource.id,
					sourceName,
					title: metadata?.title?.trim() || resource.title,
				},
				env,
			),
		)
		.catch((error) => {
			console.error({
				tag: 'OPENALEX_CONTENT',
				event: 'pdf_acquisition_failed',
				resource_id: resource.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	if (!artifact) return null;
	const acquired = await readAcquiredContentArtifact(artifact);
	console.info({
		tag: 'OPENALEX_CONTENT',
		event: 'pdf_acquired',
		resource_id: resource.id,
		chars: acquired.markdown.length,
		pages: acquired.extraction?.pages ?? null,
	});
	return acquired;
}

async function stageOpenAlexGrobidAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	resolution: PaperEnrichmentResolution,
	stepName: string,
): Promise<AcquiredContent | null> {
	const { contentGrobidXmlUrl, metadata } = resolution;
	if (!contentGrobidXmlUrl || resource.scope !== 'corpus' || resource.storage_key) return null;
	const sourceName = resource.source?.trim() || (resource.url ? new URL(resource.url).hostname : 'OpenAlex');
	const artifact = await step
		.do(stepName, ACQUISITION_STEP, () =>
			acquireOpenAlexGrobidArtifact(
				{
					contentGrobidXmlUrl,
					description: metadata?.abstract?.trim() || resource.summary,
					publishedDate: metadata?.publicationDate?.trim() || resource.published_date,
					sourceName,
					title: metadata?.title?.trim() || resource.title,
				},
				env,
			),
		)
		.catch((error) => {
			console.error({
				tag: 'OPENALEX_CONTENT',
				event: 'grobid_acquisition_failed',
				resource_id: resource.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	if (!artifact) return null;
	const acquired = await readAcquiredContentArtifact(artifact);
	console.info({
		tag: 'OPENALEX_CONTENT',
		event: 'grobid_acquired',
		resource_id: resource.id,
		chars: acquired.markdown.length,
	});
	return acquired;
}

type PreliminaryAcquisition = Readonly<{
	acquiredContent: AcquiredContent | undefined;
	explicitResolution: PaperEnrichmentResolution | null;
}>;

export async function stagePreliminaryAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	acquireFallback: () => Promise<AcquiredContent | undefined>,
): Promise<PreliminaryAcquisition> {
	const explicitResolution =
		resource.resource_platform === null && isExplicitPaperUrl(resource.url)
			? await stagePaperEnrichment(
					env,
					step,
					{ ...resource, identifiers: resource.paper_identifiers },
					{ stepName: 'resolve-explicit-paper-openalex-with-citations-v1' },
				)
			: null;
	const pdf = explicitResolution
		? await stageOpenAlexPdfAcquisition(env, step, resource, explicitResolution, 'acquire-preliminary-openalex-content-pdf-v1')
		: null;
	const grobid =
		explicitResolution && !pdf
			? await stageOpenAlexGrobidAcquisition(env, step, resource, explicitResolution, 'acquire-preliminary-openalex-content-grobid-v1')
			: null;
	return {
		acquiredContent: pdf ?? grobid ?? (await acquireFallback()),
		explicitResolution,
	};
}

export async function stagePreferredOpenAlexContent(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	acquiredContent: AcquiredContent | undefined,
	paperResolution: PaperEnrichmentResolution,
	preliminary: Pick<PreliminaryAcquisition, 'explicitResolution'>,
): Promise<{
	acquiredContent: AcquiredContent | undefined;
	resource: ResourceForProcessing;
}> {
	// The preliminary phase already attempted OpenAlex content for this exact resolution.
	if (paperResolution === preliminary.explicitResolution) {
		return { acquiredContent, resource };
	}
	const pdf = await stageOpenAlexPdfAcquisition(env, step, resource, paperResolution, 'acquire-selected-openalex-content-pdf-v1');
	if (pdf) {
		return { acquiredContent: pdf, resource: applyAcquiredMaterial(resource, pdf) };
	}
	const grobid = await stageOpenAlexGrobidAcquisition(env, step, resource, paperResolution, 'acquire-selected-openalex-content-grobid-v1');
	if (grobid) {
		return { acquiredContent: grobid, resource: applyAcquiredMaterial(resource, grobid) };
	}
	return { acquiredContent, resource };
}
