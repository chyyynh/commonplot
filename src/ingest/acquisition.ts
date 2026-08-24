import type { WorkflowStep } from 'cloudflare:workers';
import type { YouTubeResourceMutation } from '@app-domain/resource-graph-contracts';
import type { PaperIdentifier } from '@core-shared/paper-identity';
import { parseHackerNewsResourceUrl, stageHackerNewsAcquisition } from './platforms/hackernews';
import { parseLessWrongResourceUrl, stageLessWrongAcquisition } from './platforms/lesswrong';
import {
	type GenericAcquiredMaterial,
	materializeGenericResource,
	type ResolvedResource,
	type ResourceAcquisitionHints,
} from './platforms/materialize';
import { stagePaperProcessing } from './platforms/paper';
import { stageStoredPdfAcquisition, storedPdfProcessingResult } from './platforms/pdf';
import { parseTwitterResourceUrl, stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageWebAcquisition } from './platforms/web';
import { parseYouTubeResourceUrl, stageYouTubeAcquisition } from './platforms/youtube-acquisition';

export type ProcessingResource = ResolvedResource & { youtube?: YouTubeResourceMutation };

type MonitoredAcquisitionContext = Readonly<{
	avatarUrl: string | null;
}>;

function resolvePlatformResourceUrl(url: URL) {
	const hostname = url.hostname.toLowerCase();
	if (hostname === 'ycombinator.com' || hostname.endsWith('.ycombinator.com')) return parseHackerNewsResourceUrl(url);
	if (hostname === 'lesswrong.com' || hostname.endsWith('.lesswrong.com')) return parseLessWrongResourceUrl(url);
	if (hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com')) {
		return parseTwitterResourceUrl(url);
	}
	if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be' || hostname.endsWith('.youtu.be')) {
		return parseYouTubeResourceUrl(url);
	}
	return null;
}

async function resolveGenericAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: GenericAcquiredMaterial,
	input: {
		hints: ResourceAcquisitionHints;
		paperIdentifiers: readonly PaperIdentifier[];
		processingId: string;
		sourceUrl: string | null;
		translateUrl: boolean;
	},
): Promise<ResolvedResource> {
	let publishedDate = input.hints.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}

	const canonicalUrl = acquired.canonicalUrl?.trim() || input.sourceUrl;
	const paper = await stagePaperProcessing(env, step, {
		acquiredContent: acquired,
		canonicalUrl,
		originSummary: input.hints.summary,
		processingId: input.processingId,
		publishedDate,
		seedIdentifiers: input.paperIdentifiers,
		sourceUrl: input.sourceUrl,
		translateUrl: input.translateUrl,
	});
	if (!paper.acquiredContent.markdown.trim()) {
		throw new Error(`Processing ${input.processingId} has no extractable content`);
	}
	return materializeGenericResource(paper.acquiredContent, input.hints, {
		canonicalUrl,
		identity: paper.identity,
		publishedDate: paper.publishedDate,
	});
}

export async function stageUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		hints: ResourceAcquisitionHints;
		monitor: MonitoredAcquisitionContext | null;
		paperIdentifiers?: readonly PaperIdentifier[];
		processingId: string;
		url: string;
	},
): Promise<ProcessingResource> {
	let acquisitionUrl = input.url;
	let parsedUrl = URL.parse(acquisitionUrl);
	if (!parsedUrl) throw new Error(`Processing ${input.processingId} has an invalid URL`);
	let detected = resolvePlatformResourceUrl(parsedUrl);
	if (!detected) {
		const web = await stageWebAcquisition(env, step, { processingId: input.processingId, url: acquisitionUrl }, resolvePlatformResourceUrl);
		if (!('redirectUrl' in web)) {
			return resolveGenericAcquiredResource(env, step, web, {
				hints: input.hints,
				paperIdentifiers: input.paperIdentifiers ?? [],
				processingId: input.processingId,
				sourceUrl: input.url,
				translateUrl: input.monitor === null,
			});
		}
		acquisitionUrl = web.redirectUrl;
		parsedUrl = URL.parse(acquisitionUrl);
		detected = parsedUrl ? resolvePlatformResourceUrl(parsedUrl) : null;
		if (!detected) throw new Error(`Web acquisition ${input.processingId} returned an undetectable platform redirect`);
	}
	switch (detected.resourcePlatform) {
		case 'hackernews':
			return stageHackerNewsAcquisition(env, step, {
				hints: input.hints,
				itemId: detected.platformId,
				processingId: input.processingId,
			});
		case 'lesswrong':
			return stageLessWrongAcquisition(step, detected.platformId, input.hints);
		case 'twitter':
			return stageTwitterAcquisition(env, step, {
				hints: input.hints,
				processingId: input.processingId,
				tweetId: detected.platformId,
			});
		case 'youtube':
			return stageYouTubeAcquisition(env, step, {
				hints: input.hints,
				monitoredOnly: input.monitor !== null,
				processingId: input.processingId,
				sourceAvatarUrl: input.monitor?.avatarUrl ?? null,
				videoId: detected.platformId,
			});
	}
}

export async function stageStoredResource(
	env: CoreEnv,
	step: WorkflowStep,
	target: Readonly<{ resourceId: string }>,
): Promise<{
	keywordHints: readonly string[];
	resource: ProcessingResource;
	persistenceTarget: ReturnType<typeof storedPdfProcessingResult>['persistenceTarget'];
	processingId: string;
}> {
	const acquired = await stageStoredPdfAcquisition(env, step, target);
	return {
		...storedPdfProcessingResult(
			await resolveGenericAcquiredResource(env, step, acquired.material, {
				hints: {
					originalLang: acquired.resource.originalLang,
					publishedDate: acquired.resource.publishedDate,
					summary: acquired.resource.summary,
				},
				paperIdentifiers: [],
				processingId: acquired.resource.resourceId,
				sourceUrl: null,
				translateUrl: false,
			}),
			acquired.resource,
		),
		keywordHints: [],
		processingId: target.resourceId,
	};
}
