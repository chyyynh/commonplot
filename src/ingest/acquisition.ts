import type { WorkflowStep } from 'cloudflare:workers';
import type { YouTubeResourceMutation } from '@app-domain/resource-graph-contracts';
import { normalizePaperIdentifiers, paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { detectResourceUrl, normalizeUrl } from '@core-shared/url';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import {
	type GenericAcquiredMaterial,
	materializeAcquiredResource,
	type ResolvedResource,
	type ResourceAcquisitionOrigin,
} from './platforms/materialize';
import { stagePaperProcessing } from './platforms/paper';
import { stageStoredPdfAcquisition, storedPdfProcessingResult } from './platforms/pdf';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube-acquisition';
import type { ResourceProcessingWorkflowPayload } from './processing-jobs';

export type ProcessingResource = ResolvedResource & { youtube?: YouTubeResourceMutation };

async function resolveGenericAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: GenericAcquiredMaterial,
	origin: ResourceAcquisitionOrigin,
	processingId: string,
	translatePaperUrl: boolean,
): Promise<ResolvedResource> {
	let publishedDate = origin.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}

	const canonicalUrl = acquired.canonicalUrl?.trim() || origin.url;
	const exactPaper = resolveExactPaperInput(origin.url) ?? resolveExactPaperInput(canonicalUrl);
	const resourceIdentifiers = normalizePaperIdentifiers([
		...origin.resourceIdentifiers,
		...(exactPaper ? paperIdentifiersFromIdentity(exactPaper.identity) : []),
	]);
	const paper = await stagePaperProcessing(env, step, {
		acquiredContent: acquired,
		canonicalUrl,
		identifiers: resourceIdentifiers,
		originSummary: origin.summary,
		processingId,
		publishedDate,
		translateUrl: translatePaperUrl,
	});
	if (!paper.acquiredContent.markdown.trim()) {
		throw new Error(`Processing ${processingId} has no extractable content`);
	}
	return materializeAcquiredResource(paper.acquiredContent, origin, {
		canonicalUrl,
		publishedDate: paper.publishedDate,
		resourceIdentifiers: normalizePaperIdentifiers([...paper.identifiers, ...resourceIdentifiers]),
	});
}

export async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		discoverRelatedContent: boolean;
		isMonitoredOnly: boolean;
		origin: ResourceAcquisitionOrigin;
		processingId: string;
		providerSequence?: string;
		sourceAvatarUrl: string | null;
		sourceUrl: string;
		translatePaperUrl: boolean;
	},
): Promise<ProcessingResource> {
	let acquisitionUrl = normalizeUrl(input.sourceUrl);
	let detected = detectResourceUrl(acquisitionUrl);
	if (!detected) {
		const web = await stageWebAcquisition(env, step, { processingId: input.processingId, url: acquisitionUrl });
		if (!('redirectUrl' in web)) {
			return resolveGenericAcquiredResource(env, step, web, input.origin, input.processingId, input.translatePaperUrl);
		}
		acquisitionUrl = web.redirectUrl;
		detected = detectResourceUrl(acquisitionUrl);
		if (!detected) throw new Error(`Web acquisition ${input.processingId} returned an undetectable platform redirect`);
	}
	switch (detected.resourcePlatform) {
		case 'hackernews':
			return stageHackerNewsAcquisition(env, step, {
				itemId: detected.platformId,
				origin: input.origin,
				processingId: input.processingId,
			});
		case 'lesswrong':
			return stageLessWrongAcquisition(step, detected.platformId, input.origin);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				discoverRelatedContent: input.discoverRelatedContent,
				origin: input.origin,
				processingId: input.processingId,
				...(input.providerSequence ? { providerSequence: input.providerSequence } : {}),
				tweetId: detected.platformId,
			});
		case 'youtube':
			return stageYouTubeAcquisition(env, step, {
				monitoredOnly: input.isMonitoredOnly,
				origin: input.origin,
				processingId: input.processingId,
				sourceAvatarUrl: input.sourceAvatarUrl,
				videoId: detected.platformId,
			});
		default:
			detected.resourcePlatform satisfies never;
			throw new Error(`Unsupported resource platform for ${input.processingId}`);
	}
}

export async function stageStoredResource(
	env: CoreEnv,
	step: WorkflowStep,
	target: Extract<ResourceProcessingWorkflowPayload['target'], { kind: 'storedBlob' }>,
): Promise<{
	resource: ProcessingResource;
	persistenceTarget: ReturnType<typeof storedPdfProcessingResult>['persistenceTarget'];
	processingId: string;
	complete(originalTranslationRevision: string | null): Promise<void>;
}> {
	const acquired = await stageStoredPdfAcquisition(env, step, target);
	return {
		...storedPdfProcessingResult(
			await resolveGenericAcquiredResource(env, step, acquired.material, acquired.resource, acquired.resource.resourceId, false),
			acquired.resource,
		),
		processingId: target.parseAdmission.parseRunId,
		complete: acquired.complete,
	};
}
