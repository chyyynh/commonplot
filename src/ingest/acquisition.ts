import type { WorkflowStep } from 'cloudflare:workers';
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '@core-shared/paper-identity';
import { isPaperIdentifier, normalizeResourceIdentifiers } from '@core-shared/resource-identifiers';
import type { AcquiredResource, ResolvedResource } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl } from '@core-shared/url';
import { stageHackerNewsAcquisition } from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { materializeAcquiredResource, type ResourceAcquisitionOrigin } from './platforms/materialize';
import { stagePaperProcessing } from './platforms/paper';
import {
	type StoredPdfAcquisitionInput,
	type StoredPdfProcessingResult,
	stageStoredPdfAcquisition,
	storedPdfProcessingResult,
} from './platforms/pdf';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { stageYouTubeAcquisition } from './platforms/youtube-acquisition';

type GenericAcquiredResource = Extract<AcquiredResource, { resourcePlatform: null }>;

async function resolveGenericAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: GenericAcquiredResource,
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
	if (!detected) {
		const web = await stageWebAcquisition(env, step, { processingId: input.processingId, url: acquisitionUrl });
		if (!('redirectUrl' in web)) {
			return resolveGenericAcquiredResource(
				env,
				step,
				{ ...web, specialization: null },
				input.origin,
				input.processingId,
				input.translatePaperUrl,
			);
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

export async function stageStoredPdfResource(
	env: CoreEnv,
	step: WorkflowStep,
	resource: StoredPdfAcquisitionInput & ResourceAcquisitionOrigin & { storageKey: string },
): Promise<StoredPdfProcessingResult> {
	const acquired = await stageStoredPdfAcquisition(env, step, resource);
	return storedPdfProcessingResult(
		await resolveGenericAcquiredResource(env, step, acquired, resource, resource.resourceId, false),
		resource,
	);
}
