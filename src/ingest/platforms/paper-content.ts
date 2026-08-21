// OpenAlex-hosted paper content: cached PDF and GROBID TEI staging for the processing Workflow.

import type { WorkflowStep } from 'cloudflare:workers';
import {
	ACQUISITION_STEP,
	type AcquiredContent,
	acquiredContentArtifact,
	readAcquiredContentArtifact,
	sanitizeAcquiredContent,
} from '../acquisition';
import { acquireOpenAlexGrobidText, acquireOpenAlexPdf } from './openalex';
import type { PaperEnrichmentResolution } from './paper';

type PaperContentCandidate = {
	processingId: string;
	publishedDate: string | null;
	source: string | null;
	summary: string | null;
	title: string;
	url: string | null;
};

async function acquireOpenAlexPdfArtifact(
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
	const acquired = await acquireOpenAlexPdf({
		apiKey: env.OPENALEX_API_KEY,
		contentPdfUrl: input.contentPdfUrl,
	});
	const sourceName = input.sourceName.trim();
	if (!sourceName) throw new Error(`Processing ${input.processingId} has no source name for its OpenAlex PDF`);
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

export async function stageOpenAlexContentAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: PaperContentCandidate,
	resolution: PaperEnrichmentResolution,
): Promise<AcquiredContent | null> {
	const { contentGrobidXmlUrl, contentPdfUrl, metadata } = resolution;
	if (!contentPdfUrl && !contentGrobidXmlUrl) return null;

	const sourceName = resource.source?.trim() || (resource.url ? new URL(resource.url).hostname : 'OpenAlex');
	const description = metadata?.abstract?.trim() || resource.summary;
	const publishedDate = metadata?.publicationDate?.trim() || resource.publishedDate;
	const title = metadata?.title?.trim() || resource.title;

	if (contentPdfUrl) {
		const artifact = await step
			.do('acquire-openalex-content-pdf-v2', ACQUISITION_STEP, () =>
				acquireOpenAlexPdfArtifact(
					{
						contentPdfUrl,
						description,
						publishedDate,
						processingId: resource.processingId,
						sourceName,
						title,
					},
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
		if (artifact) {
			const acquired = await readAcquiredContentArtifact(artifact);
			console.info({
				tag: 'OPENALEX_CONTENT',
				event: 'pdf_acquired',
				processing_id: resource.processingId,
				chars: acquired.markdown.length,
				pages: acquired.provider === null ? (acquired.extraction?.pages ?? null) : null,
			});
			return acquired;
		}
	}

	if (contentGrobidXmlUrl) {
		const artifact = await step
			.do('acquire-openalex-content-grobid-v2', ACQUISITION_STEP, () =>
				acquireOpenAlexGrobidArtifact(
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
		if (artifact) {
			const acquired = await readAcquiredContentArtifact(artifact);
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
