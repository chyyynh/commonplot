import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { AcquiredMaterial, ResolvedResource } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { z } from 'zod';
import { acquiredContentSchema, normalizeAcquiredContent } from './acquired-content';
import { type HackerNewsAcquiredContent, HackerNewsItemSchema, scrapeHackerNews, stageHackerNewsEnrichment } from './platforms/hackernews';
import { scrapeLessWrong } from './platforms/lesswrong';
import {
	logSequencedTwitterAcquisitionAttempt,
	scrapeTweet,
	TWITTER_SEQUENCED_ACQUISITION_STEP_CONFIG,
} from './platforms/twitter-acquisition';
import { scrapeYouTube, stageYouTubeEnrichment, YouTubeTranscriptSchema } from './platforms/youtube-acquisition';
import {
	materializeAcquiredResource,
	type ResourceMaterializationOrigin,
	type ResourceMaterializationResolution,
} from './resource-resolver';
import { type AcquiredWebContent, acquireWebResource, type PlatformRedirect } from './web-acquisition';

type RawAcquiredContent =
	| AcquiredWebContent
	| HackerNewsAcquiredContent
	| AcquiredMaterial<'lesswrong'>
	| AcquiredMaterial<'twitter'>
	| AcquiredMaterial<'youtube'>;

export type AcquiredContent = RawAcquiredContent & { sourceSnapshotHash: string };

type SavedUrlAcquisitionResult =
	| { status: 'acquired'; content: AcquiredContent }
	| { status: 'redirect'; redirectUrl: string }
	| { status: 'rejected'; message: string };

const platformIdSchema = z.string().trim().min(1);
const AcquiredContentSchema: z.ZodType<AcquiredContent> = z.discriminatedUnion('resourcePlatform', [
	acquiredContentSchema(null, {}),
	acquiredContentSchema('hackernews', {
		hackerNewsItem: HackerNewsItemSchema,
		platformId: platformIdSchema,
	}),
	acquiredContentSchema('lesswrong', { platformId: platformIdSchema }),
	acquiredContentSchema('twitter', { platformId: platformIdSchema }),
	acquiredContentSchema('youtube', {
		platformId: platformIdSchema,
		youtubeTranscript: YouTubeTranscriptSchema,
	}),
]);
const SavedUrlAcquisitionResultSchema: z.ZodType<SavedUrlAcquisitionResult> = z.discriminatedUnion('status', [
	z.object({ status: z.literal('acquired'), content: AcquiredContentSchema }),
	z.object({ status: z.literal('redirect'), redirectUrl: z.url() }),
	z.object({ status: z.literal('rejected'), message: z.string().trim().min(1).max(500) }),
]);

// Provider rejections are converted to a serializable result inside the step,
// so only transient transport/provider failures reach Workflow retries.
const ACQUISITION_STEP = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '120 seconds',
} as const;

export class ResourceProcessingRejectedError extends Error {}

function validateAcquisitionUrl(url: string): string {
	const parsed = parseExternalHttpUrl(url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	return normalizeUrl(parsed.toString());
}

async function acquireSavedUrlRoute(
	url: string,
	env: CoreEnv,
	monitoredOnly: boolean,
	sourceAvatarUrl: string | null,
	processingId: string,
	providerSequence?: string,
	discoverRelatedContent = true,
): Promise<AcquiredContent | PlatformRedirect> {
	const detected = detectResourceUrl(url);
	if (detected) {
		switch (detected.resourcePlatform) {
			case 'youtube':
				return normalizeAcquiredContent({
					...(await scrapeYouTube(detected.platformId, env.YOUTUBE_API_KEY, monitoredOnly, sourceAvatarUrl)),
					canonicalUrl: url,
				});
			case 'twitter':
				return normalizeAcquiredContent({
					...(await scrapeTweet(detected.platformId, env.KAITO_API_KEY, {
						discoverUnsignaledThread: discoverRelatedContent,
						expectedReplyId: providerSequence,
					})),
					canonicalUrl: url,
				});
			case 'hackernews':
				return normalizeAcquiredContent({ ...(await scrapeHackerNews(detected.platformId)), canonicalUrl: url });
			case 'lesswrong':
				return normalizeAcquiredContent({ ...(await scrapeLessWrong(detected.platformId)), canonicalUrl: url });
			default:
				detected.resourcePlatform satisfies never;
		}
	}
	const web = await acquireWebResource(url, env, processingId);
	return 'redirectUrl' in web ? web : normalizeAcquiredContent(web);
}

async function scrapeSavedUrlArtifact(
	url: string,
	env: CoreEnv,
	monitoredOnly: boolean,
	sourceAvatarUrl: string | null,
	processingId: string,
	providerSequence?: string,
	discoverRelatedContent = true,
): Promise<ReadableStream<Uint8Array>> {
	try {
		const acquired = await acquireSavedUrlRoute(
			url,
			env,
			monitoredOnly,
			sourceAvatarUrl,
			processingId,
			providerSequence,
			discoverRelatedContent,
		);
		const result: SavedUrlAcquisitionResult =
			'redirectUrl' in acquired ? { status: 'redirect', redirectUrl: acquired.redirectUrl } : { status: 'acquired', content: acquired };
		return new Blob([JSON.stringify(result)], { type: 'application/json' }).stream();
	} catch (error) {
		if (!(error instanceof NonRetryableError)) throw error;
		const message = error.message.trim().slice(0, 500) || 'Resource acquisition was rejected';
		return new Blob([JSON.stringify({ status: 'rejected', message })], { type: 'application/json' }).stream();
	}
}

async function readSavedUrlAcquisitionArtifact(artifact: ReadableStream<Uint8Array>): Promise<SavedUrlAcquisitionResult> {
	return SavedUrlAcquisitionResultSchema.parse(await new Response(artifact).json());
}

export async function stageSavedUrlAcquisition(
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
): Promise<AcquiredContent> {
	let acquisitionUrl = validateAcquisitionUrl(input.sourceUrl);
	for (let route = 0; route < 5; route++) {
		const platform = detectResourceUrl(acquisitionUrl)?.resourcePlatform ?? null;
		const sequencedTwitter = platform === 'twitter' && !!providerSequence;
		const acquisition = await readSavedUrlAcquisitionArtifact(
			await step.do(
				`acquire-content-route-v2-${route}`,
				sequencedTwitter ? TWITTER_SEQUENCED_ACQUISITION_STEP_CONFIG : ACQUISITION_STEP,
				(ctx) => {
					if (sequencedTwitter) logSequencedTwitterAcquisitionAttempt(input.processingId, providerSequence, ctx.attempt);
					return scrapeSavedUrlArtifact(
						acquisitionUrl,
						env,
						input.isMonitoredOnly,
						input.sourceAvatarUrl,
						input.processingId,
						providerSequence,
						input.discoverRelatedContent,
					);
				},
			),
		);
		if (acquisition.status === 'rejected') throw new ResourceProcessingRejectedError(acquisition.message);
		if (acquisition.status === 'acquired') return acquisition.content;
		acquisitionUrl = validateAcquisitionUrl(acquisition.redirectUrl);
	}
	throw new ResourceProcessingRejectedError(`Resource acquisition ${input.processingId} exceeded its platform redirect limit`);
}

export async function resolveAcquiredResource(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: AcquiredContent,
	origin: ResourceMaterializationOrigin,
	resolution: ResourceMaterializationResolution,
	processingId: string,
): Promise<ResolvedResource> {
	switch (acquired.resourcePlatform) {
		case 'hackernews':
			return {
				...materializeAcquiredResource(await stageHackerNewsEnrichment(env, step, acquired, processingId), origin, resolution),
				specialization: null,
			};
		case 'youtube':
			return {
				...materializeAcquiredResource(acquired, origin, resolution),
				specialization: await stageYouTubeEnrichment(env, step, acquired, processingId),
			};
		case null:
		case 'lesswrong':
		case 'twitter':
			return { ...materializeAcquiredResource(acquired, origin, resolution), specialization: null };
		default:
			acquired satisfies never;
			throw new Error(`Unsupported acquired resource platform for ${processingId}`);
	}
}
