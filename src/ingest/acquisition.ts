import type { WorkflowStep } from 'cloudflare:workers';
import { sha256Hex } from '@core-shared/hash';
import { literalCreator, type ResourceCreator, type ResourceKindMetadata } from '@core-shared/resource-metadata';
import type { ResourcePlatform } from '@core-shared/resource-types';
import type { AcquiredMaterial, ResourceForProcessing } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl } from '@core-shared/url';
import { z } from 'zod';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';
import { canonicalForumFields, type HackerNewsItem, scrapeHackerNews } from './platforms/hackernews';
import { acquireRssFeedItem, type RssFeedAcquisitionInput } from './platforms/rss-feed';
import { canonicalPostFields, scrapeTweet } from './platforms/twitter-acquisition';
import { stageTweetLinkUnfurl } from './platforms/twitter-unfurl';
import { canonicalVideoFields, scrapeYouTube } from './platforms/youtube-acquisition';
import { type AcquiredWebContent, acquireWebResource, PDF_MIME } from './web-acquisition';

export type AcquiredContent =
	| AcquiredWebContent
	| (AcquiredMaterial<'hackernews'> & { hackerNewsItem: HackerNewsItem })
	| AcquiredMaterial<'twitter'>
	| AcquiredMaterial<'youtube'>;

const nullableStringSchema = z.string().nullable();
const acquiredMetadataSchema = z.object({
	author: nullableStringSchema,
	language: nullableStringSchema,
	publishedDate: nullableStringSchema,
	siteName: z.string().trim().min(1),
	description: nullableStringSchema,
});
const resourceRepresentationSchema = z.object({
	fileName: z.string(),
	fileSize: z.number().nonnegative(),
});
const acquisitionEnvelopeShape = {
	sourceSnapshotHash: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
	representation: resourceRepresentationSchema.optional(),
};
const acquiredContentShape = {
	fileType: nullableStringSchema,
	title: z.string().trim().min(1),
	markdown: z.string(),
	previewImageUrl: nullableStringSchema.optional(),
	metadata: acquiredMetadataSchema,
};
const youtubeTranscriptSchema = z.object({
	videoId: z.string().min(1),
	segments: z.array(z.object({ startTime: z.number(), endTime: z.number(), text: z.string() })),
	language: nullableStringSchema,
	chapters: z.array(z.object({ title: z.string(), startTime: z.number(), endTime: z.number().optional() })),
	chaptersFromDescription: z.boolean(),
});

function acquiredMaterialSchema<const T extends ResourcePlatform, Data extends z.ZodType, Extra extends z.ZodRawShape>(
	provider: T,
	data: Data,
	extra: Extra,
) {
	return z.looseObject({
		provider: z.literal(provider),
		...acquiredContentShape,
		acquisition: z.looseObject({ ...acquisitionEnvelopeShape, data }),
		...extra,
	});
}

const AcquiredContentSchema: z.ZodType<AcquiredContent> = z.discriminatedUnion('provider', [
	acquiredMaterialSchema(null, z.null(), {
		extraction: z.object({ status: z.enum(['ok', 'needs_ocr']), pages: z.number() }).optional(),
		ownedStorageKey: z.string().min(1).optional(),
	}),
	acquiredMaterialSchema('hackernews', z.looseObject({}), {
		hackerNewsItem: z.looseObject({ id: z.number().int().positive() }),
	}),
	acquiredMaterialSchema('twitter', z.looseObject({ authorName: z.string(), authorUserName: z.string() }), {}),
	acquiredMaterialSchema('youtube', z.looseObject({ channelName: z.string() }), {
		youtubeTranscript: youtubeTranscriptSchema,
	}),
]);

/**
 * Acquisition gets one attempt, not three.
 *
 * Measured, because the docs suggest otherwise: NonRetryableError thrown inside
 * a step does *not* skip its retries — three runs against a page with no
 * article recorded three attempts whether it was thrown from the step callback
 * or from the scraper, with the class serialised away to plain `Error` each
 * time. The only lever the platform actually honours is retries.limit.
 *
 * Setting it to 0 also removes a duplicated layer: a failed acquisition is
 * already retried by the monitors, on a 30m/1h/2h/4h backoff that gives up after
 * MAX_ENRICHMENT_ATTEMPTS. Ten-second retries only ever helped a blip shorter
 * than the outer schedule, and cost every doomed URL three fetches instead of
 * one.
 */
export const ACQUISITION_STEP = { retries: { limit: 0, delay: '10 seconds' }, timeout: '120 seconds' } as const;

/** Optional provider enrichments remain inside acquisition, never Workflow orchestration. */
export async function stageAcquisitionEnhancements(
	step: WorkflowStep,
	acquired: AcquiredContent,
	resourceId: string,
): Promise<AcquiredContent> {
	if (acquired.provider !== 'twitter') return acquired;
	return stageTweetLinkUnfurl(step, acquired, resourceId);
}

function acquiredPublishedDate(value: string | null): string | null {
	if (!value?.trim()) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function canonicalFieldsFromAcquisition(acquired: AcquiredMaterial): {
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
} {
	switch (acquired.provider) {
		case null:
			return {
				creators: literalCreator('author', acquired.metadata.author),
				kindMetadata: acquired.metadata.siteName.trim() ? { siteName: acquired.metadata.siteName.trim() } : null,
			};
		case 'hackernews':
			return canonicalForumFields(acquired.acquisition);
		case 'twitter':
			return canonicalPostFields(acquired.acquisition);
		case 'youtube':
			return canonicalVideoFields(acquired.acquisition);
	}
}

export function applyAcquiredMaterial(resource: ResourceForProcessing, acquired?: AcquiredContent): ResourceForProcessing {
	if (!acquired) return resource;
	const canonical = canonicalFieldsFromAcquisition(acquired);
	const ownedStorageKey = acquired.provider === null ? acquired.ownedStorageKey : undefined;
	return {
		...resource,
		title: acquired.title.trim(),
		summary: acquired.metadata.description,
		content: acquired.markdown,
		source: acquired.metadata.siteName,
		creators: canonical.creators,
		kind_metadata: canonical.kindMetadata,
		source_revision: acquired.acquisition.sourceSnapshotHash ?? resource.source_revision ?? null,
		file_type: acquired.fileType,
		storage_key: ownedStorageKey ?? resource.storage_key,
		published_date: resource.published_date ?? acquiredPublishedDate(acquired.metadata.publishedDate),
	};
}

function validateAcquisitionUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return normalizeUrl(parsed.toString());
}

function sourceSnapshotHash(acquired: AcquiredContent, markdown: string): Promise<string> {
	const input = JSON.stringify({
		provider: acquired.provider,
		fileType: acquired.fileType,
		title: acquired.title,
		markdown,
		metadata: acquired.metadata,
		platformData: acquired.acquisition.data,
		representation: acquired.acquisition.representation,
	});
	return sha256Hex(input);
}

export async function sanitizeAcquiredContent(acquired: AcquiredContent): Promise<AcquiredContent> {
	const markdown = sanitizeExtractedMarkdown(acquired.markdown);
	const sourceSnapshotHashValue = await sourceSnapshotHash(acquired, markdown);
	switch (acquired.provider) {
		case null:
			return { ...acquired, markdown, acquisition: { ...acquired.acquisition, sourceSnapshotHash: sourceSnapshotHashValue } };
		case 'hackernews':
			return { ...acquired, markdown, acquisition: { ...acquired.acquisition, sourceSnapshotHash: sourceSnapshotHashValue } };
		case 'twitter':
			return { ...acquired, markdown, acquisition: { ...acquired.acquisition, sourceSnapshotHash: sourceSnapshotHashValue } };
		case 'youtube':
			return { ...acquired, markdown, acquisition: { ...acquired.acquisition, sourceSnapshotHash: sourceSnapshotHashValue } };
	}
}

async function scrapeSavedUrl(url: string, env: CoreEnv, monitored: boolean, resourceId: string): Promise<AcquiredContent> {
	const validatedUrl = validateAcquisitionUrl(url);
	const detected = detectResourceUrl(validatedUrl);
	if (detected) {
		switch (detected.resourcePlatform) {
			case 'youtube':
				return sanitizeAcquiredContent(await scrapeYouTube(detected.platformId, env.YOUTUBE_API_KEY, monitored));
			case 'twitter':
				return sanitizeAcquiredContent(await scrapeTweet(detected.platformId, env.KAITO_API_KEY));
			case 'hackernews':
				return sanitizeAcquiredContent(await scrapeHackerNews(detected.platformId));
			default:
				detected.resourcePlatform satisfies never;
		}
	}

	return sanitizeAcquiredContent(await acquireWebResource(validatedUrl, env, resourceId));
}

export async function scrapeSavedUrlArtifact(
	url: string,
	env: CoreEnv,
	monitored: boolean,
	resourceId: string,
): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeSavedUrl(url, env, monitored, resourceId);
	return acquiredContentArtifact(acquired);
}

export async function scrapeRssFeedItemArtifact(input: RssFeedAcquisitionInput, env: CoreEnv): Promise<ReadableStream<Uint8Array>> {
	return acquiredContentArtifact(await sanitizeAcquiredContent(await acquireRssFeedItem(env, input)));
}

export function acquiredContentArtifact(acquired: AcquiredContent): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

export async function readAcquiredContentArtifact(artifact: ReadableStream<Uint8Array>): Promise<AcquiredContent> {
	const acquired = AcquiredContentSchema.parse(await new Response(artifact).json());
	if (acquired.fileType === PDF_MIME && !acquired.acquisition.representation) {
		throw new Error('PDF acquisition artifact has no representation metadata; rerun canonical acquisition');
	}
	return acquired;
}
