import type { WorkflowStep } from 'cloudflare:workers';
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { isPaperIdentifier, normalizeResourceIdentifiers } from '@core-shared/resource-identifiers';
import type { AcquiredResource, MaterializedResource, ResolvedResource } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { stagePaperProcessing } from './platforms/paper';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageYouTubeAcquisition } from './platforms/youtube-acquisition';
import { materializeAcquiredResource, type ResourceMaterializationOrigin } from './resource-resolver';
import { stageWebAcquisition } from './web-acquisition';

export type ResourceResolutionOrigin = ResourceMaterializationOrigin & Pick<MaterializedResource, 'resourceIdentifiers'>;

function validateAcquisitionUrl(url: string): string {
	const parsed = parseExternalHttpUrl(url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	return normalizeUrl(parsed.toString());
}

export async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		discoverRelatedContent: boolean;
		isMonitoredOnly: boolean;
		processingId: string;
		sourceAvatarUrl: string | null;
		sourceUrl: string;
	},
	providerSequence?: string,
): Promise<AcquiredResource> {
	let acquisitionUrl = validateAcquisitionUrl(input.sourceUrl);
	let detected = detectResourceUrl(acquisitionUrl);
	if (!detected) {
		const acquired = await stageWebAcquisition(env, step, { processingId: input.processingId, url: acquisitionUrl });
		if (!('redirectUrl' in acquired)) return { ...acquired, specialization: null };
		acquisitionUrl = validateAcquisitionUrl(acquired.redirectUrl);
		detected = detectResourceUrl(acquisitionUrl);
		if (!detected) throw new Error(`Web acquisition ${input.processingId} returned an undetectable platform redirect`);
	}

	switch (detected.resourcePlatform) {
		case 'hackernews':
			return stageHackerNewsAcquisition(env, step, { itemId: detected.platformId, processingId: input.processingId });
		case 'lesswrong':
			return stageLessWrongAcquisition(step, detected.platformId);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				discoverRelatedContent: input.discoverRelatedContent,
				processingId: input.processingId,
				...(providerSequence ? { providerSequence } : {}),
				tweetId: detected.platformId,
			});
		case 'youtube':
			return stageYouTubeAcquisition(env, step, {
				monitoredOnly: input.isMonitoredOnly,
				processingId: input.processingId,
				sourceAvatarUrl: input.sourceAvatarUrl,
				videoId: detected.platformId,
			});
		default:
			detected.resourcePlatform satisfies never;
			throw new Error(`Unsupported resource platform for ${input.processingId}`);
	}
}

export async function resolveAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: AcquiredResource,
	origin: ResourceResolutionOrigin,
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
