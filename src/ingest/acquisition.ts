import { isResourcePlatform } from '@core-shared/resource-types';
import type { AcquiredMaterial, PdfExtractionMetadata, ResourceForProcessing } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl } from '@core-shared/url';
import { canonicalFieldsFromAcquisition } from './canonical-resource';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';
import { type HackerNewsItem, scrapeHackerNews } from './platforms/hackernews';
import { acquireOpenAlexGrobidText, acquireOpenAlexPdf } from './platforms/openalex';
import { acquireRssFeedItem, type RssFeedAcquisitionInput } from './platforms/rss-feed';
import { scrapeTweet } from './platforms/twitter-acquisition';
import { applyTweetLinkUnfurl, pendingTweetExternalLink, unfurlTweetExternalLink } from './platforms/twitter-unfurl';
import { scrapeYouTube } from './platforms/youtube-acquisition';
import { acquireWebResource, PDF_MIME, pdfExtractionMetadata } from './web-acquisition';

export type { PdfExtractionMetadata } from '@core-shared/types';
export { PDF_MIME, pdfExtractionMetadata };

export type AcquiredContent = AcquiredMaterial & {
	extraction?: PdfExtractionMetadata;
	hackerNewsItem?: HackerNewsItem;
};

/** Optional provider enrichments remain inside acquisition, never Workflow orchestration. */
export async function stageAcquisitionEnhancements(
	step: WorkflowStep,
	acquired: AcquiredContent,
	resourceId: string,
): Promise<AcquiredContent> {
	if (acquired.provider !== 'twitter') return acquired;
	const twitter = acquired as AcquiredContent & AcquiredMaterial<'twitter'>;
	const externalUrl = pendingTweetExternalLink(twitter);
	if (!externalUrl) return acquired;
	const outcome = await step
		.do('unfurl-tweet-external-link', { retries: { limit: 1, delay: '5 seconds' }, timeout: '30 seconds' }, async () => ({
			unfurl: await unfurlTweetExternalLink(externalUrl),
		}))
		.catch((error) => {
			console.error({
				tag: 'TWITTER',
				msg: 'Optional external-link unfurl failed; card stays hidden',
				resource_id: resourceId,
				external_url: externalUrl,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	if (!outcome) return acquired;
	console.info({
		tag: 'TWITTER',
		msg: outcome.unfurl ? 'External link unfurled' : 'External link exposed no OG image',
		resource_id: resourceId,
		external_url: externalUrl,
	});
	return applyTweetLinkUnfurl(twitter, outcome.unfurl);
}

function acquiredPublishedDate(value: string | null): string | null {
	if (!value?.trim()) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function applyAcquiredMaterial(resource: ResourceForProcessing, acquired?: AcquiredContent): ResourceForProcessing {
	if (!acquired) return resource;
	const canonical = canonicalFieldsFromAcquisition(acquired);
	const ownedStorageKey =
		'ownedStorageKey' in acquired && typeof acquired.ownedStorageKey === 'string' ? acquired.ownedStorageKey : undefined;
	return {
		...resource,
		title: acquired.title.trim(),
		summary: acquired.metadata.description,
		content: acquired.markdown,
		source: acquired.metadata.siteName,
		og_image_url: acquired.previewImageUrl?.trim() || resource.og_image_url?.trim() || null,
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

async function sourceSnapshotHash(acquired: AcquiredContent): Promise<string> {
	const input = JSON.stringify({
		provider: acquired.provider,
		fileType: acquired.fileType,
		title: acquired.title,
		markdown: acquired.markdown,
		metadata: acquired.metadata,
		platformData: acquired.acquisition.data,
		representation: acquired.acquisition.representation,
	});
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sanitizeAcquiredContent(acquired: AcquiredContent): Promise<AcquiredContent> {
	const markdown = sanitizeExtractedMarkdown(acquired.markdown);
	const sanitized = markdown === acquired.markdown ? acquired : { ...acquired, markdown };
	return {
		...sanitized,
		acquisition: {
			...sanitized.acquisition,
			sourceSnapshotHash: await sourceSnapshotHash(sanitized),
		},
	};
}

/**
 * What a monitored feed contributes is a curation decision; what someone types in
 * is not. Only the monitored path applies the feed policies, so a deliberately
 * saved URL is never rejected for being the kind of thing we don't crawl.
 */
export type AcquisitionOrigin = { monitored: boolean };

async function scrapeSavedUrl(url: string, env: CoreEnv, origin: AcquisitionOrigin, resourceId: string): Promise<AcquiredContent> {
	const validatedUrl = validateAcquisitionUrl(url);
	const detected = detectResourceUrl(validatedUrl);
	if (detected) {
		switch (detected.resourcePlatform) {
			case 'youtube':
				return sanitizeAcquiredContent(await scrapeYouTube(detected.platformId, env.YOUTUBE_API_KEY, origin));
			case 'twitter':
				return sanitizeAcquiredContent(await scrapeTweet(detected.platformId, env.KAITO_API_KEY));
			case 'hackernews':
				return sanitizeAcquiredContent(await scrapeHackerNews(detected.platformId, env, resourceId));
			default:
				detected.resourcePlatform satisfies never;
		}
	}

	return sanitizeAcquiredContent(await acquireWebResource(validatedUrl, env, resourceId));
}

export async function scrapeSavedUrlArtifact(
	url: string,
	env: CoreEnv,
	origin: AcquisitionOrigin,
	resourceId: string,
): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeSavedUrl(url, env, origin, resourceId);
	return acquiredContentArtifact(acquired);
}

export async function acquireOpenAlexPdfArtifact(
	input: {
		contentPdfUrl: string;
		description: string | null;
		publishedDate: string | null;
		resourceId: string;
		sourceName: string;
		title: string;
	},
	env: CoreEnv,
): Promise<ReadableStream<Uint8Array>> {
	const acquired = await acquireOpenAlexPdf({
		apiKey: env.OPENALEX_API_KEY,
		contentPdfUrl: input.contentPdfUrl,
		env,
		resourceId: input.resourceId,
	});
	const sourceName = input.sourceName.trim();
	if (!sourceName) throw new Error(`Resource ${input.resourceId} has no source name for its OpenAlex PDF`);
	return acquiredContentArtifact(
		await sanitizeAcquiredContent({
			...acquired,
			title: input.title,
			metadata: {
				...acquired.metadata,
				description: input.description,
				publishedDate: input.publishedDate,
				siteName: sourceName,
			},
		}),
	);
}

export async function acquireOpenAlexGrobidArtifact(
	input: {
		contentGrobidXmlUrl: string;
		description: string | null;
		publishedDate: string | null;
		sourceName: string;
		title: string;
	},
	env: CoreEnv,
): Promise<ReadableStream<Uint8Array>> {
	const markdown = await acquireOpenAlexGrobidText({
		contentGrobidXmlUrl: input.contentGrobidXmlUrl,
		env,
	});
	const sourceName = input.sourceName.trim();
	if (!sourceName) throw new Error('OpenAlex GROBID acquisition has no source name');
	return acquiredContentArtifact(
		await sanitizeAcquiredContent({
			provider: null,
			fileType: null,
			title: input.title,
			markdown,
			metadata: {
				author: null,
				description: input.description,
				language: null,
				publishedDate: input.publishedDate,
				siteName: sourceName,
			},
			acquisition: {
				fetchedAt: new Date().toISOString(),
				data: null,
			},
		}),
	);
}

export async function scrapeRssFeedItemArtifact(input: RssFeedAcquisitionInput, env: CoreEnv): Promise<ReadableStream<Uint8Array>> {
	return acquiredContentArtifact(await sanitizeAcquiredContent(await acquireRssFeedItem(env, input)));
}

function acquiredContentArtifact(acquired: AcquiredContent): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && !!value.trim();
}

function isAcquiredContent(value: unknown): value is AcquiredContent {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const content = value as Record<string, unknown>;
	if (!isNonEmptyString(content.title) || typeof content.markdown !== 'string') {
		return false;
	}
	if (!isResourcePlatform(content.provider) || !isNullableString(content.fileType)) return false;
	if (content.ownedStorageKey !== undefined && !isNonEmptyString(content.ownedStorageKey)) return false;
	if (!content.metadata || typeof content.metadata !== 'object' || Array.isArray(content.metadata)) return false;
	if (!content.acquisition || typeof content.acquisition !== 'object' || Array.isArray(content.acquisition)) return false;
	const metadata = content.metadata as Record<string, unknown>;
	const acquisition = content.acquisition as Record<string, unknown>;
	return (
		isNullableString(metadata.author) &&
		isNullableString(metadata.language) &&
		isNullableString(metadata.publishedDate) &&
		isNonEmptyString(metadata.siteName) &&
		isNullableString(metadata.description) &&
		isNonEmptyString(acquisition.fetchedAt) &&
		Object.hasOwn(acquisition, 'data')
	);
}

export async function readAcquiredContentArtifact(artifact: ReadableStream<Uint8Array>): Promise<AcquiredContent> {
	const acquired: unknown = await new Response(artifact).json();
	if (!isAcquiredContent(acquired)) throw new Error('Acquisition artifact did not contain valid content');
	if (acquired.fileType === PDF_MIME && !acquired.acquisition.representation) {
		throw new Error('PDF acquisition artifact has no representation metadata; rerun canonical acquisition');
	}
	return acquired;
}

import type { WorkflowStep } from 'cloudflare:workers';
