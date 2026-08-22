import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sha256Hex } from '@core-shared/hash';
import { parseResourceCreators, parseStoredResourceKindMetadata } from '@core-shared/resource-metadata';
import { type ResourcePlatform, resourceIdentityForDetectedPlatform } from '@core-shared/resource-types';
import type { AcquiredMaterial, MaterializedResource, ResolvedResource } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { z } from 'zod';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';
import { type HackerNewsAcquiredContent, HackerNewsItemSchema, scrapeHackerNews, stageHackerNewsEnrichment } from './platforms/hackernews';
import { scrapeLessWrong } from './platforms/lesswrong';
import { scrapeTweet } from './platforms/twitter-acquisition';
import { scrapeYouTube, stageYouTubeEnrichment, YouTubeTranscriptSchema } from './platforms/youtube-acquisition';
import { type AcquiredWebContent, acquireWebResource } from './web-acquisition';

type RawAcquiredContent =
	| AcquiredWebContent
	| HackerNewsAcquiredContent
	| AcquiredMaterial<'lesswrong'>
	| AcquiredMaterial<'twitter'>
	| AcquiredMaterial<'youtube'>;

export type AcquiredContent = RawAcquiredContent & { sourceSnapshotHash: string };

type SavedUrlAcquisitionResult = { status: 'acquired'; content: AcquiredContent } | { status: 'rejected'; message: string };

const nullableStringSchema = z.string().nullable();
const platformIdSchema = z.string().trim().min(1);
const acquiredContentShape = {
	canonicalUrl: z.url().optional(),
	fileType: nullableStringSchema,
	title: z.string().trim().min(1),
	markdown: z.string(),
	previewImageUrl: nullableStringSchema.optional(),
	subjectUrl: z.string().optional(),
	source: z.string().trim().min(1),
	originalLang: nullableStringSchema,
	publishedDate: nullableStringSchema,
	summary: nullableStringSchema,
	creators: z.unknown().transform((value) => parseResourceCreators(value)),
	sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
};
function acquiredMaterialSchema<const T extends ResourcePlatform, Extra extends z.ZodRawShape>(resourcePlatform: T, extra: Extra) {
	const kind = resourcePlatform === null ? 'blog' : resourceIdentityForDetectedPlatform(resourcePlatform).kind;
	return z.looseObject({
		resourcePlatform: z.literal(resourcePlatform),
		...acquiredContentShape,
		kindMetadata: z.unknown().transform((value) => parseStoredResourceKindMetadata(kind, value)),
		...extra,
	});
}

const AcquiredContentSchema: z.ZodType<AcquiredContent> = z.discriminatedUnion('resourcePlatform', [
	acquiredMaterialSchema(null, {}),
	acquiredMaterialSchema('hackernews', {
		hackerNewsItem: HackerNewsItemSchema,
		platformId: platformIdSchema,
	}),
	acquiredMaterialSchema('lesswrong', { platformId: platformIdSchema }),
	acquiredMaterialSchema('twitter', { platformId: platformIdSchema }),
	acquiredMaterialSchema('youtube', {
		platformId: platformIdSchema,
		youtubeTranscript: YouTubeTranscriptSchema,
	}),
]);
const SavedUrlAcquisitionResultSchema: z.ZodType<SavedUrlAcquisitionResult> = z.discriminatedUnion('status', [
	z.object({ status: z.literal('acquired'), content: AcquiredContentSchema }),
	z.object({ status: z.literal('rejected'), message: z.string().trim().min(1).max(500) }),
]);

// Provider rejections are converted to a serializable result inside the step,
// so only transient transport/provider failures reach Workflow retries.
export const ACQUISITION_STEP = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '120 seconds',
} as const;

function validateAcquisitionUrl(url: string): string {
	const parsed = parseExternalHttpUrl(url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	return normalizeUrl(parsed.toString());
}

function acquiredSourceSnapshotHash(acquired: RawAcquiredContent, markdown: string): Promise<string> {
	const providerFacts =
		acquired.resourcePlatform !== null || acquired.subjectUrl
			? {
					...(acquired.resourcePlatform !== null ? { platformId: acquired.platformId } : {}),
					...(acquired.subjectUrl ? { subjectUrl: acquired.subjectUrl } : {}),
				}
			: null;
	const input = JSON.stringify({
		resourcePlatform: acquired.resourcePlatform,
		canonicalUrl: acquired.canonicalUrl,
		fileType: acquired.fileType,
		title: acquired.title,
		markdown,
		source: acquired.source,
		originalLang: acquired.originalLang,
		publishedDate: acquired.publishedDate,
		summary: acquired.summary,
		creators: acquired.creators,
		kindMetadata: acquired.kindMetadata,
		providerFacts,
	});
	return sha256Hex(input);
}

export async function sanitizeAcquiredContent(acquired: RawAcquiredContent): Promise<AcquiredContent> {
	const markdown = sanitizeExtractedMarkdown(acquired.markdown);
	return { ...acquired, markdown, sourceSnapshotHash: await acquiredSourceSnapshotHash(acquired, markdown) };
}

async function scrapeSavedUrl(
	url: string,
	env: CoreEnv,
	monitoredOnly: boolean,
	sourceAvatarUrl: string | null,
	processingId: string,
	providerSequence?: string,
	discoverRelatedContent = true,
): Promise<AcquiredContent> {
	let acquisitionUrl = validateAcquisitionUrl(url);
	for (;;) {
		const detected = detectResourceUrl(acquisitionUrl);
		if (detected) {
			switch (detected.resourcePlatform) {
				case 'youtube':
					return sanitizeAcquiredContent({
						...(await scrapeYouTube(detected.platformId, env.YOUTUBE_API_KEY, monitoredOnly, sourceAvatarUrl)),
						canonicalUrl: acquisitionUrl,
					});
				case 'twitter':
					return sanitizeAcquiredContent({
						...(await scrapeTweet(detected.platformId, env.KAITO_API_KEY, {
							discoverUnsignaledThread: discoverRelatedContent,
							expectedReplyId: providerSequence,
						})),
						canonicalUrl: acquisitionUrl,
					});
				case 'hackernews':
					return sanitizeAcquiredContent({ ...(await scrapeHackerNews(detected.platformId)), canonicalUrl: acquisitionUrl });
				case 'lesswrong':
					return sanitizeAcquiredContent({ ...(await scrapeLessWrong(detected.platformId)), canonicalUrl: acquisitionUrl });
				default:
					detected.resourcePlatform satisfies never;
			}
		}

		const web = await acquireWebResource(acquisitionUrl, env, processingId);
		if ('redirectUrl' in web) {
			acquisitionUrl = validateAcquisitionUrl(web.redirectUrl);
			continue;
		}
		return sanitizeAcquiredContent(web);
	}
}

export async function scrapeSavedUrlArtifact(
	url: string,
	env: CoreEnv,
	monitoredOnly: boolean,
	sourceAvatarUrl: string | null,
	processingId: string,
	providerSequence?: string,
	discoverRelatedContent = true,
): Promise<ReadableStream<Uint8Array>> {
	try {
		const result: SavedUrlAcquisitionResult = {
			status: 'acquired',
			content: await scrapeSavedUrl(url, env, monitoredOnly, sourceAvatarUrl, processingId, providerSequence, discoverRelatedContent),
		};
		return new Blob([JSON.stringify(result)], { type: 'application/json' }).stream();
	} catch (error) {
		if (!(error instanceof NonRetryableError)) throw error;
		const message = error.message.trim().slice(0, 500) || 'Resource acquisition was rejected';
		return new Blob([JSON.stringify({ status: 'rejected', message })], { type: 'application/json' }).stream();
	}
}

export function acquiredContentArtifact(acquired: AcquiredContent): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

export async function readAcquiredContentArtifact(artifact: ReadableStream<Uint8Array>): Promise<AcquiredContent> {
	return AcquiredContentSchema.parse(await new Response(artifact).json());
}

export async function readSavedUrlAcquisitionArtifact(artifact: ReadableStream<Uint8Array>): Promise<SavedUrlAcquisitionResult> {
	return SavedUrlAcquisitionResultSchema.parse(await new Response(artifact).json());
}

export async function stagePlatformEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: AcquiredContent,
	resource: MaterializedResource,
	processingId: string,
): Promise<ResolvedResource> {
	switch (acquired.resourcePlatform) {
		case 'hackernews': {
			if (resource.resourcePlatform !== 'hackernews')
				throw new Error(`Hacker News processing ${processingId} resolved to another platform`);
			return { ...(await stageHackerNewsEnrichment(env, step, resource, acquired, processingId)), specialization: null };
		}
		case 'youtube': {
			if (resource.resourcePlatform !== 'youtube') throw new Error(`YouTube processing ${processingId} resolved to another platform`);
			return stageYouTubeEnrichment(env, step, resource, acquired, processingId);
		}
		case null:
			if (resource.resourcePlatform !== null) throw new Error(`Web processing ${processingId} resolved to a platform resource`);
			return { ...resource, specialization: null };
		case 'lesswrong':
			if (resource.resourcePlatform !== 'lesswrong') throw new Error(`LessWrong processing ${processingId} resolved to another platform`);
			return { ...resource, specialization: null };
		case 'twitter':
			if (resource.resourcePlatform !== 'twitter') throw new Error(`Twitter processing ${processingId} resolved to another platform`);
			return { ...resource, specialization: null };
		default:
			acquired satisfies never;
			throw new Error(`Unsupported acquired resource platform for ${processingId}`);
	}
}
