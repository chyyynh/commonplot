import { NonRetryableError } from 'cloudflare:workflows';
import { sha256Hex } from '@core-shared/hash';
import { parseResourceCreators, parseStoredResourceKindMetadata } from '@core-shared/resource-metadata';
import { type ContentResourceKind, canonicalizeOptionalResourceLang, type ResourcePlatform } from '@core-shared/resource-types';
import type { AcquiredMaterial, ResourceForProcessing } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { z } from 'zod';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';
import { type HackerNewsItem, scrapeHackerNews } from './platforms/hackernews';
import { scrapeLessWrong } from './platforms/lesswrong';
import { scrapeTweet } from './platforms/twitter-acquisition';
import { scrapeYouTube } from './platforms/youtube-acquisition';
import { type AcquiredWebContent, acquireWebResource } from './web-acquisition';

export type AcquiredContent =
	| AcquiredWebContent
	| (AcquiredMaterial<'hackernews'> & { hackerNewsItem: HackerNewsItem })
	| AcquiredMaterial<'lesswrong'>
	| AcquiredMaterial<'twitter'>
	| AcquiredMaterial<'youtube'>;

type SavedUrlAcquisitionResult = { status: 'acquired'; content: AcquiredContent } | { status: 'rejected'; message: string };

const nullableStringSchema = z.string().nullable();
const acquiredContentShape = {
	canonicalUrl: z.url().optional(),
	fileType: nullableStringSchema,
	title: z.string().trim().min(1),
	markdown: z.string(),
	previewImageUrl: nullableStringSchema.optional(),
	source: z.string().trim().min(1),
	originalLang: nullableStringSchema,
	publishedDate: nullableStringSchema,
	summary: nullableStringSchema,
	creators: z.unknown().transform((value) => parseResourceCreators(value)),
	sourceSnapshotHash: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
};
const youtubeTranscriptSchema = z.object({
	videoId: z.string().min(1),
	segments: z.array(z.object({ startTime: z.number(), endTime: z.number(), text: z.string() })),
	language: nullableStringSchema,
	chapters: z.array(z.object({ title: z.string(), startTime: z.number(), endTime: z.number().optional() })),
	chaptersFromDescription: z.boolean(),
});

function acquiredMaterialSchema<const T extends ResourcePlatform, Extra extends z.ZodRawShape>(
	provider: T,
	kind: ContentResourceKind,
	extra: Extra,
) {
	return z.looseObject({
		provider: z.literal(provider),
		...acquiredContentShape,
		kindMetadata: z.unknown().transform((value) => parseStoredResourceKindMetadata(kind, value)),
		...extra,
	});
}

const AcquiredContentSchema: z.ZodType<AcquiredContent> = z.discriminatedUnion('provider', [
	acquiredMaterialSchema(null, 'blog', {
		extraction: z.object({ status: z.enum(['ok', 'needs_ocr']), pages: z.number() }).optional(),
	}),
	acquiredMaterialSchema('hackernews', 'forum', {
		hackerNewsItem: z.looseObject({ id: z.number().int().positive() }),
	}),
	acquiredMaterialSchema('lesswrong', 'blog', {}),
	acquiredMaterialSchema('twitter', 'post', { subjectUrl: z.string().optional() }),
	acquiredMaterialSchema('youtube', 'video', {
		durationSeconds: z.number().nonnegative().nullable(),
		youtubeTranscript: youtubeTranscriptSchema,
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

export function applyAcquiredMaterial(resource: ResourceForProcessing, acquired?: AcquiredContent): ResourceForProcessing {
	if (!acquired) return resource;
	const canonicalUrl = acquired.canonicalUrl?.trim();
	let publishedDate = resource.published_date;
	if (publishedDate === null && acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	return {
		...resource,
		title: acquired.title.trim(),
		summary: acquired.summary ?? resource.summary,
		content: acquired.markdown,
		source: acquired.source,
		original_lang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? resource.original_lang,
		creators: acquired.creators,
		kind_metadata: acquired.kindMetadata,
		source_revision: acquired.sourceSnapshotHash ?? resource.source_revision ?? null,
		file_type: acquired.fileType,
		storage_key: resource.scope === 'private' ? resource.storage_key : null,
		url: canonicalUrl ?? resource.url,
		normalized_url: canonicalUrl ?? resource.normalized_url,
		published_date: publishedDate,
	};
}

function validateAcquisitionUrl(url: string): string {
	const parsed = parseExternalHttpUrl(url);
	if (!parsed) throw new Error('Only http(s) URLs without credentials are allowed');
	return normalizeUrl(parsed.toString());
}

function acquiredSourceSnapshotHash(acquired: AcquiredContent, markdown: string): Promise<string> {
	const providerFacts =
		acquired.provider === 'twitter'
			? { subjectUrl: acquired.subjectUrl }
			: acquired.provider === 'youtube'
				? { durationSeconds: acquired.durationSeconds }
				: null;
	const input = JSON.stringify({
		provider: acquired.provider,
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

export async function sanitizeAcquiredContent(acquired: AcquiredContent): Promise<AcquiredContent> {
	const markdown = sanitizeExtractedMarkdown(acquired.markdown);
	return { ...acquired, markdown, sourceSnapshotHash: await acquiredSourceSnapshotHash(acquired, markdown) };
}

async function scrapeSavedUrl(
	url: string,
	env: CoreEnv,
	monitoredOnly: boolean,
	sourceAvatarUrl: string | null,
	processingId: string,
	expectedProviderRevision?: string,
	discoverTwitterThread = true,
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
							discoverUnsignaledThread: discoverTwitterThread,
							expectedReplyId: expectedProviderRevision,
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
	expectedProviderRevision?: string,
	discoverTwitterThread = true,
): Promise<ReadableStream<Uint8Array>> {
	try {
		const result: SavedUrlAcquisitionResult = {
			status: 'acquired',
			content: await scrapeSavedUrl(
				url,
				env,
				monitoredOnly,
				sourceAvatarUrl,
				processingId,
				expectedProviderRevision,
				discoverTwitterThread,
			),
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
