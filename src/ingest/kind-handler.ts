import type { WorkflowStep } from 'cloudflare:workers';
import { literalCreator, type PaperKindMetadata } from '@core-shared/resource-metadata';
import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import type { AcquiredContent } from './acquisition';
import { applyHackerNewsAnnotation, buildHackerNewsAnnotation } from './platforms/hackernews';
import { prepareYouTubeHighlights, type YouTubeHighlightsUpdate } from './platforms/youtube';
import { exactPlatformLocator } from './resource-resolver';

export type HandledResourceResult = Readonly<{
	resource: ResourceForProcessing;
	classificationExclusions: string[];
	youtube: Readonly<{
		transcript: YoutubeTranscript | null;
		highlights: YouTubeHighlightsUpdate | null;
	}> | null;
}>;

type HandleContext = Readonly<{
	acquiredContent: AcquiredContent | undefined;
	env: CoreEnv;
	paperEnrichment: PaperMetadata | null;
	resource: ResourceForProcessing;
	step: WorkflowStep;
}>;

/** OpenAlex fields become canonical once academic enrichment resolves the work. */
function finalizedPaperResource(resource: ResourceForProcessing, metadata: PaperMetadata | null): ResourceForProcessing {
	if (!metadata) return resource;

	let publishedDate = resource.published_date;
	if (!publishedDate && metadata.publicationDate) {
		const candidate = new Date(`${metadata.publicationDate}T00:00:00.000Z`);
		if (!Number.isNaN(candidate.getTime())) publishedDate = candidate.toISOString();
	}
	const abstract = metadata.abstract?.trim();
	const kindMetadata: PaperKindMetadata = {
		...(metadata.venue?.trim() ? { venue: metadata.venue.trim() } : {}),
		...(metadata.year === undefined ? {} : { year: metadata.year }),
		...(metadata.citedByCount === undefined ? {} : { citedByCount: metadata.citedByCount }),
		...(metadata.referenceCount === undefined ? {} : { referenceCount: metadata.referenceCount }),
		...(metadata.pdfUrl?.trim() ? { pdfUrl: metadata.pdfUrl.trim() } : {}),
		...(metadata.references ? { references: metadata.references } : {}),
		...(metadata.citations ? { citations: metadata.citations } : {}),
	};
	return {
		...resource,
		...(abstract ? { summary: abstract } : {}),
		published_date: publishedDate,
		creators: metadata.authors.flatMap((author) => literalCreator('author', author)),
		kind_metadata: kindMetadata,
	};
}

async function handleForum(context: HandleContext): Promise<HandledResourceResult> {
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
				processing_id: context.resource.processing_id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	return {
		resource:
			annotation && context.resource.content
				? { ...context.resource, content: applyHackerNewsAnnotation(context.resource.content, annotation) }
				: context.resource,
		classificationExclusions: ['HackerNews'],
		youtube: null,
	};
}

async function handleVideo(context: HandleContext): Promise<HandledResourceResult> {
	const locator = exactPlatformLocator(context.resource.resource_identifiers);
	if (locator?.resourcePlatform !== 'youtube') {
		throw new Error(`YouTube processing ${context.resource.processing_id} has no exact video identifier`);
	}
	const youtubeTranscript = context.acquiredContent?.provider === 'youtube' ? context.acquiredContent.youtubeTranscript : null;
	const youtubeHighlights = await context.step
		.do('prepare-youtube-highlights', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' }, () =>
			prepareYouTubeHighlights(context.env, context.resource, locator.platformId, youtubeTranscript ?? undefined),
		)
		.catch((error) => {
			console.error({
				tag: 'YOUTUBE',
				msg: 'Optional YouTube highlights failed after retries',
				processing_id: context.resource.processing_id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	return {
		resource: context.resource,
		classificationExclusions: [],
		youtube: youtubeTranscript || youtubeHighlights ? { transcript: youtubeTranscript, highlights: youtubeHighlights } : null,
	};
}

export async function handleResolvedResource(context: HandleContext): Promise<HandledResourceResult> {
	switch (context.resource.kind) {
		case 'blog':
			return { resource: context.resource, classificationExclusions: [], youtube: null };
		case 'forum':
			return handleForum(context);
		case 'post':
			return {
				resource: context.resource,
				classificationExclusions: ['Twitter'],
				youtube: null,
			};
		case 'video':
			return handleVideo(context);
		case 'paper':
			return {
				resource: finalizedPaperResource(context.resource, context.paperEnrichment),
				classificationExclusions: [],
				youtube: null,
			};
	}
}
