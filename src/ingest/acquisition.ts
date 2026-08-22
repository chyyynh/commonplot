import type { WorkflowStep } from 'cloudflare:workers';
import type { AcquiredMaterial, ResolvedResource } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { z } from 'zod';
import { type AcquisitionArtifactResult, acquiredContentSchema } from './acquired-content';
import {
	type HackerNewsAcquiredContent,
	HackerNewsItemSchema,
	stageHackerNewsAcquisition,
	stageHackerNewsEnrichment,
} from './platforms/hackernews';
import { stageLessWrongAcquisition } from './platforms/lesswrong';
import { stageTwitterAcquisition } from './platforms/twitter-acquisition';
import { stageYouTubeAcquisition, stageYouTubeEnrichment, YouTubeTranscriptSchema } from './platforms/youtube-acquisition';
import {
	materializeAcquiredResource,
	type ResourceMaterializationOrigin,
	type ResourceMaterializationResolution,
} from './resource-resolver';
import { stageWebAcquisition } from './web-acquisition';

type RawAcquiredContent =
	| AcquiredMaterial<null>
	| HackerNewsAcquiredContent
	| AcquiredMaterial<'lesswrong'>
	| AcquiredMaterial<'twitter'>
	| AcquiredMaterial<'youtube'>;

export type AcquiredContent = RawAcquiredContent & { sourceSnapshotHash: string };

type SavedUrlAcquisitionResult = AcquisitionArtifactResult<AcquiredContent>;

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

export class ResourceProcessingRejectedError extends Error {}

function validateAcquisitionUrl(url: string): string {
	const parsed = parseExternalHttpUrl(url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	return normalizeUrl(parsed.toString());
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
		const detected = detectResourceUrl(acquisitionUrl);
		let artifact: Promise<ReadableStream<Uint8Array>>;
		if (!detected) {
			artifact = stageWebAcquisition(env, step, { processingId: input.processingId, route, url: acquisitionUrl });
		} else {
			switch (detected.resourcePlatform) {
				case 'hackernews':
					artifact = stageHackerNewsAcquisition(step, { itemId: detected.platformId, route, url: acquisitionUrl });
					break;
				case 'lesswrong':
					artifact = stageLessWrongAcquisition(step, { postId: detected.platformId, route, url: acquisitionUrl });
					break;
				case 'twitter':
					artifact = stageTwitterAcquisition(env, step, {
						discoverRelatedContent: input.discoverRelatedContent,
						processingId: input.processingId,
						...(providerSequence ? { providerSequence } : {}),
						route,
						tweetId: detected.platformId,
						url: acquisitionUrl,
					});
					break;
				case 'youtube':
					artifact = stageYouTubeAcquisition(env, step, {
						monitoredOnly: input.isMonitoredOnly,
						route,
						sourceAvatarUrl: input.sourceAvatarUrl,
						url: acquisitionUrl,
						videoId: detected.platformId,
					});
					break;
				default:
					detected.resourcePlatform satisfies never;
					throw new Error(`Unsupported resource platform for ${input.processingId}`);
			}
		}
		const acquisition = await readSavedUrlAcquisitionArtifact(await artifact);
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
