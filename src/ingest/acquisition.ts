import type { WorkflowStep } from 'cloudflare:workers';
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { isPaperIdentifier, normalizeResourceIdentifiers } from '@core-shared/resource-identifiers';
import type { AcquiredResource, ResolvedResource } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl } from '@core-shared/url';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { materializeAcquiredResource, type ResourceAcquisitionOrigin } from './platforms/materialize';
import { stagePaperProcessing } from './platforms/paper';
import { type StoredPdfAcquisitionInput, stageStoredPdfAcquisition } from './platforms/pdf';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube-acquisition';

async function resolveAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: AcquiredResource,
	origin: ResourceAcquisitionOrigin,
	processingId: string,
	translatePaperUrl: boolean,
): Promise<ResolvedResource> {
	let publishedDate = origin.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}

	if (acquired.resourcePlatform === null) {
		const canonicalUrl = acquired.canonicalUrl?.trim() || origin.url;
		const exactPaper = resolveExactPaperInput(origin.url) ?? resolveExactPaperInput(canonicalUrl);
		const resourceIdentifiers = normalizeResourceIdentifiers([
			...origin.resourceIdentifiers,
			...(exactPaper ? paperIdentifiersFromIdentity(exactPaper.identity) : []),
		]);
		const paper = await stagePaperProcessing(env, step, {
			acquiredContent: acquired,
			canonicalUrl,
			identifiers: resourceIdentifiers.filter(isPaperIdentifier),
			originSummary: origin.summary,
			processingId,
			publishedDate,
			translateUrl: translatePaperUrl,
		});
		if (!paper.acquiredContent.markdown.trim()) {
			throw new Error(`Processing ${processingId} has no extractable content`);
		}
		return materializeAcquiredResource({ ...paper.acquiredContent, specialization: null }, origin, {
			canonicalUrl,
			publishedDate: paper.publishedDate,
			resourceIdentifiers: normalizeResourceIdentifiers([...paper.identifiers, ...resourceIdentifiers]),
		});
	}

	if (!acquired.markdown.trim()) {
		throw new Error(`Processing ${processingId} has no extractable content`);
	}
	return materializeAcquiredResource(acquired, origin, { canonicalUrl: null, publishedDate, resourceIdentifiers: [] });
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
): Promise<ResolvedResource> {
	let acquisitionUrl = normalizeUrl(input.sourceUrl);
	let detected = detectResourceUrl(acquisitionUrl);
	let acquired: AcquiredResource | null = null;
	if (!detected) {
		const web = await stageWebAcquisition(env, step, { processingId: input.processingId, url: acquisitionUrl });
		if (!('redirectUrl' in web)) {
			acquired = { ...web, specialization: null };
		} else {
			acquisitionUrl = web.redirectUrl;
			detected = detectResourceUrl(acquisitionUrl);
			if (!detected) throw new Error(`Web acquisition ${input.processingId} returned an undetectable platform redirect`);
		}
	}
	if (detected) {
		switch (detected.resourcePlatform) {
			case 'hackernews':
				acquired = await stageHackerNewsAcquisition(env, step, { itemId: detected.platformId, processingId: input.processingId });
				break;
			case 'lesswrong':
				acquired = await stageLessWrongAcquisition(step, detected.platformId);
				break;
			case 'twitter':
				acquired = await stageTwitterAcquisition(env, step, {
					discoverRelatedContent: input.discoverRelatedContent,
					processingId: input.processingId,
					...(input.providerSequence ? { providerSequence: input.providerSequence } : {}),
					tweetId: detected.platformId,
				});
				break;
			case 'youtube':
				acquired = await stageYouTubeAcquisition(env, step, {
					monitoredOnly: input.isMonitoredOnly,
					processingId: input.processingId,
					sourceAvatarUrl: input.sourceAvatarUrl,
					videoId: detected.platformId,
				});
				break;
			default:
				detected.resourcePlatform satisfies never;
				throw new Error(`Unsupported resource platform for ${input.processingId}`);
		}
	}
	if (!acquired) throw new Error(`Resource platform routing failed for ${input.processingId}`);
	return resolveAcquiredResource(env, step, acquired, input.origin, input.processingId, input.translatePaperUrl);
}

export async function stageStoredPdfResource(
	env: CoreEnv,
	step: WorkflowStep,
	resource: StoredPdfAcquisitionInput & ResourceAcquisitionOrigin,
): Promise<ResolvedResource> {
	const acquired = await stageStoredPdfAcquisition(env, step, resource);
	return resolveAcquiredResource(env, step, acquired, resource, resource.resourceId, false);
}
