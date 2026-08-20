import type { WorkflowStep } from 'cloudflare:workers';
import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import type { AcquiredContent } from './acquisition';
import { buildHackerNewsContent } from './platforms/hackernews';
import { prepareYouTubeHighlights, type YouTubeHighlightsUpdate } from './platforms/youtube';
import type { ResolvedContentResourceInput } from './resource-resolver';

type HandledBase<K extends ResolvedContentResourceInput['kind']> = Readonly<{
	kind: K;
	resolution: Extract<ResolvedContentResourceInput, { kind: K }>;
	resource: ResourceForProcessing;
	classificationExclusions?: string[];
}>;

export type HandledResourceResult =
	| HandledBase<'blog'>
	| HandledBase<'forum'>
	| HandledBase<'post'>
	| (HandledBase<'video'> &
			Readonly<{
				youtubeTranscript?: YoutubeTranscript;
				youtubeHighlights: YouTubeHighlightsUpdate | null;
			}>)
	| (HandledBase<'paper'> & Readonly<{ paperEnrichment: PaperMetadata | null }>);

type HandleContext = Readonly<{
	acquiredContent: AcquiredContent | undefined;
	env: CoreEnv;
	paperEnrichment: PaperMetadata | null;
	resolution: ResolvedContentResourceInput;
	resource: ResourceForProcessing;
	step: WorkflowStep;
}>;

async function handleForum(context: HandleContext): Promise<HandledResourceResult> {
	const content = await context.step
		.do('build-hacker-news-content', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' }, () =>
			buildHackerNewsContent(context.resource, context.env, context.acquiredContent?.hackerNewsItem),
		)
		.catch((error) => {
			console.error({
				tag: 'HN',
				msg: 'Optional Hacker News discussion annotation failed after retries',
				resource_id: context.resource.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	return {
		kind: 'forum',
		resolution: context.resolution as Extract<ResolvedContentResourceInput, { kind: 'forum' }>,
		resource: content ? { ...context.resource, content } : context.resource,
		classificationExclusions: ['HackerNews'],
	};
}

async function handleVideo(
	context: HandleContext,
	resolution: Extract<ResolvedContentResourceInput, { kind: 'video' }>,
): Promise<HandledResourceResult> {
	const youtubeTranscript = context.acquiredContent?.youtubeTranscript;
	const youtubeHighlights = await context.step
		.do('prepare-youtube-highlights', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' }, () =>
			prepareYouTubeHighlights(context.env, context.resource, resolution.locator.videoId, youtubeTranscript),
		)
		.catch((error) => {
			console.error({
				tag: 'YOUTUBE',
				msg: 'Optional YouTube highlights failed after retries',
				resource_id: context.resource.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	return {
		kind: 'video',
		resolution,
		resource: context.resource,
		youtubeTranscript,
		youtubeHighlights,
	};
}

export async function handleResolvedResource(context: HandleContext): Promise<HandledResourceResult> {
	switch (context.resolution.kind) {
		case 'blog':
			return { kind: 'blog', resolution: context.resolution, resource: context.resource };
		case 'forum':
			return handleForum(context);
		case 'post':
			return {
				kind: 'post',
				resolution: context.resolution,
				resource: context.resource,
				classificationExclusions: ['Twitter'],
			};
		case 'video':
			return handleVideo(context, context.resolution);
		case 'paper':
			return {
				kind: 'paper',
				resolution: context.resolution,
				resource: context.resource,
				paperEnrichment: context.paperEnrichment,
			};
	}
}
