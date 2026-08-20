import type { WorkflowStep } from 'cloudflare:workers';
import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import type { AcquiredContent } from './acquisition';
import { applyHackerNewsAnnotation, buildHackerNewsAnnotation } from './platforms/hackernews';
import { prepareYouTubeHighlights, type YouTubeHighlightsUpdate } from './platforms/youtube';
import type { ResolvedContentResourceInput } from './resource-resolver';

type HandledBase<K extends ResolvedContentResourceInput['kind']> = Extract<ResolvedContentResourceInput, { kind: K }> &
	Readonly<{
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

async function handleForum(
	context: HandleContext,
	resolution: Extract<ResolvedContentResourceInput, { kind: 'forum' }>,
): Promise<HandledResourceResult> {
	const hackerNewsItem = context.acquiredContent?.provider === 'hackernews' ? context.acquiredContent.hackerNewsItem : undefined;
	const annotation = await context.step
		.do(
			'build-hacker-news-annotation-v1',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			() => buildHackerNewsAnnotation(context.resource, context.env, hackerNewsItem),
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
		...resolution,
		resource:
			annotation && context.resource.content
				? { ...context.resource, content: applyHackerNewsAnnotation(context.resource.content, annotation) }
				: context.resource,
		classificationExclusions: ['HackerNews'],
	};
}

async function handleVideo(
	context: HandleContext,
	resolution: Extract<ResolvedContentResourceInput, { kind: 'video' }>,
): Promise<HandledResourceResult> {
	const youtubeTranscript = context.acquiredContent?.provider === 'youtube' ? context.acquiredContent.youtubeTranscript : undefined;
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
		...resolution,
		resource: context.resource,
		youtubeTranscript,
		youtubeHighlights,
	};
}

export async function handleResolvedResource(context: HandleContext): Promise<HandledResourceResult> {
	switch (context.resolution.kind) {
		case 'blog':
			return { ...context.resolution, resource: context.resource };
		case 'forum':
			return handleForum(context, context.resolution);
		case 'post':
			return {
				...context.resolution,
				resource: context.resource,
				classificationExclusions: ['Twitter'],
			};
		case 'video':
			return handleVideo(context, context.resolution);
		case 'paper':
			return {
				...context.resolution,
				resource: context.resource,
				paperEnrichment: context.paperEnrichment,
			};
	}
}
