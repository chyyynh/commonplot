// OpenAlex-hosted paper content: cached PDF and GROBID TEI staging for the processing Workflow.

import type { WorkflowStep } from 'cloudflare:workers';
import { isPaperIdentifier } from '@core-shared/resource-identifiers';
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
			source: sourceName,
			publishedDate: input.publishedDate,
			summary: input.description,
			kindMetadata: { siteName: sourceName },
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
			source: sourceName,
			originalLang: null,
			publishedDate: input.publishedDate,
			summary: input.description,
			creators: [],
			kindMetadata: { siteName: sourceName },
		}),
	);
}

async function stageOpenAlexContentAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	resolution: PaperEnrichmentResolution,
	phase: 'preliminary' | 'selected',
): Promise<AcquiredContent | null> {
	const { contentGrobidXmlUrl, contentPdfUrl, metadata } = resolution;
	if ((!contentPdfUrl && !contentGrobidXmlUrl) || resource.scope !== 'corpus' || resource.storage_key) return null;

	const sourceName = resource.source?.trim() || (resource.url ? new URL(resource.url).hostname : 'OpenAlex');
	const description = metadata?.abstract?.trim() || resource.summary;
	const publishedDate = metadata?.publicationDate?.trim() || resource.published_date;
	const title = metadata?.title?.trim() || resource.title;
	const pdfStepName = phase === 'preliminary' ? 'acquire-preliminary-openalex-content-pdf-v1' : 'acquire-selected-openalex-content-pdf-v1';
	const grobidStepName =
		phase === 'preliminary' ? 'acquire-preliminary-openalex-content-grobid-v1' : 'acquire-selected-openalex-content-grobid-v1';

	if (contentPdfUrl) {
		const artifact = await step
			.do(pdfStepName, ACQUISITION_STEP, () =>
				acquireOpenAlexPdfArtifact({ contentPdfUrl, description, publishedDate, resourceId: resource.id, sourceName, title }, env),
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
		if (artifact) {
			const acquired = await readAcquiredContentArtifact(artifact);
			console.info({
				tag: 'OPENALEX_CONTENT',
				event: 'pdf_acquired',
				resource_id: resource.id,
				chars: acquired.markdown.length,
				pages: acquired.provider === null ? (acquired.extraction?.pages ?? null) : null,
			});
			return acquired;
		}
	}

	if (contentGrobidXmlUrl) {
		const artifact = await step
			.do(grobidStepName, ACQUISITION_STEP, () =>
				acquireOpenAlexGrobidArtifact({ contentGrobidXmlUrl, description, publishedDate, sourceName, title }, env),
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
		if (artifact) {
			const acquired = await readAcquiredContentArtifact(artifact);
			console.info({
				tag: 'OPENALEX_CONTENT',
				event: 'grobid_acquired',
				resource_id: resource.id,
				chars: acquired.markdown.length,
			});
			return acquired;
		}
	}

	return null;
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
					{ ...resource, identifiers: resource.resource_identifiers.filter(isPaperIdentifier) },
					{ stepName: 'resolve-explicit-paper-openalex-with-citations-v1' },
				)
			: null;
	const openAlexContent = explicitResolution
		? await stageOpenAlexContentAcquisition(env, step, resource, explicitResolution, 'preliminary')
		: null;
	return {
		acquiredContent: openAlexContent ?? (await acquireFallback()),
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
	const openAlexContent = await stageOpenAlexContentAcquisition(env, step, resource, paperResolution, 'selected');
	if (openAlexContent) {
		return { acquiredContent: openAlexContent, resource: applyAcquiredMaterial(resource, openAlexContent) };
	}
	return { acquiredContent, resource };
}
