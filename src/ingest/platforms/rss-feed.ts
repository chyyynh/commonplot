import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { normalizedResourceImageUrl } from '@core-shared/resource-image-mapping';
import { extractHackerNewsId, normalizeUrl, parseExternalHttpUrl } from '@core-shared/url';
import { parseFeed } from 'feedsmith';
import { decode } from 'html-entities';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;

type ParsedFeed = ReturnType<typeof parseFeed>;
type ParsedRssItem = NonNullable<Extract<ParsedFeed, { format: 'rss' }>['feed']['items']>[number];
type ParsedAtomEntry = NonNullable<Extract<ParsedFeed, { format: 'atom' }>['feed']['entries']>[number];
type ParsedRdfItem = NonNullable<Extract<ParsedFeed, { format: 'rdf' }>['feed']['items']>[number];
type ParsedJsonItem = NonNullable<Extract<ParsedFeed, { format: 'json' }>['feed']['items']>[number];

interface FeedMedia {
	thumbnails?: Array<{ url?: string }>;
	contents?: Array<{ url?: string; type?: string; medium?: string }>;
	groups?: Array<{
		thumbnails?: Array<{ url?: string }>;
		contents?: Array<{ url?: string; type?: string; medium?: string }>;
	}>;
}

export interface FeedItem {
	id: string;
	link?: string;
	title?: string;
	summary?: string;
	published?: string;
	language?: string;
	previewImageUrl?: string;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function decodedString(value: unknown): string | undefined {
	const text = optionalString(value);
	return text ? decode(text).trim() || undefined : undefined;
}

function alternateAtomLink(entry: ParsedAtomEntry): string | undefined {
	const links = entry.links ?? [];
	return optionalString(links.find((link) => !link.rel || link.rel === 'alternate')?.href) ?? optionalString(links[0]?.href);
}

function firstMediaImage(media: FeedMedia | undefined): string | undefined {
	const groups = media?.groups ?? [];
	const thumbnails = [...(media?.thumbnails ?? []), ...groups.flatMap((group) => group.thumbnails ?? [])];
	const thumbnail = thumbnails.map((item) => optionalString(item.url)).find(Boolean);
	if (thumbnail) return thumbnail;

	const contents = [...(media?.contents ?? []), ...groups.flatMap((group) => group.contents ?? [])];
	return contents
		.filter((item) => item.medium === 'image' || item.type?.toLowerCase().startsWith('image/'))
		.map((item) => optionalString(item.url))
		.find(Boolean);
}

function firstHtmlImage(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
	return optionalString(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function resolvedHttpUrl(value: string | undefined, baseUrl: string | undefined): string | undefined {
	return normalizedResourceImageUrl(value, baseUrl) ?? undefined;
}

function rssFeedItem(item: ParsedRssItem, language: string | undefined): FeedItem {
	const itemLink = optionalString(item.link);
	const guid = optionalString(item.guid?.value);
	const permalinkGuid = item.guid?.isPermaLink !== false && guid?.match(/^https?:\/\//i) ? guid : undefined;
	const link = permalinkGuid ?? itemLink;
	const summary = optionalString(item.description);
	const encodedContent = optionalString(item.content?.encoded);
	const content = encodedContent ?? summary;
	const previewImage = firstMediaImage(item.media) ?? firstHtmlImage(content);
	return {
		id: guid ?? link ?? '',
		link,
		title: decodedString(item.title),
		summary,
		published: optionalString(item.pubDate) ?? optionalString(item.dc?.dates?.[0]),
		language,
		previewImageUrl: resolvedHttpUrl(previewImage, link),
	};
}

function atomFeedItem(entry: ParsedAtomEntry): FeedItem {
	const link = alternateAtomLink(entry);
	const content = optionalString(entry.content);
	const previewImage = firstMediaImage(entry.media) ?? firstHtmlImage(content);
	return {
		id: optionalString(entry.id) ?? link ?? '',
		link,
		title: decodedString(entry.title),
		summary: optionalString(entry.summary),
		published: optionalString(entry.published) ?? optionalString(entry.updated),
		language: optionalString(entry.dc?.languages?.[0]),
		previewImageUrl: resolvedHttpUrl(previewImage, link),
	};
}

function rdfFeedItem(item: ParsedRdfItem, language: string | undefined): FeedItem {
	const link = optionalString(item.link);
	const summary = optionalString(item.description);
	const encodedContent = optionalString(item.content?.encoded);
	const content = encodedContent ?? summary;
	const previewImage = firstMediaImage(item.media) ?? firstHtmlImage(content);
	return {
		id: optionalString(item.rdf?.about) ?? link ?? '',
		link,
		title: decodedString(item.title),
		summary,
		published: optionalString(item.dc?.dates?.[0]),
		language,
		previewImageUrl: resolvedHttpUrl(previewImage, link),
	};
}

function jsonFeedItem(item: ParsedJsonItem, feedLanguage: string | undefined): FeedItem {
	const link = optionalString(item.url) ?? optionalString(item.external_url);
	return {
		id: optionalString(item.id) ?? link ?? '',
		link,
		title: decodedString(item.title),
		summary: optionalString(item.summary),
		published: optionalString(item.date_published) ?? optionalString(item.date_modified),
		language: optionalString(item.language) ?? feedLanguage,
		previewImageUrl: resolvedHttpUrl(optionalString(item.image) ?? optionalString(item.banner_image), link),
	};
}

function parseFeedItems(body: string): FeedItem[] {
	const parsed = parseFeed(body, { maxItems: MAX_FEED_ITEMS });
	if (parsed.format === 'rss') {
		const language = optionalString(parsed.feed.language);
		return (parsed.feed.items ?? []).map((item) => rssFeedItem(item, language));
	}
	if (parsed.format === 'atom') return (parsed.feed.entries ?? []).map(atomFeedItem);
	if (parsed.format === 'rdf') {
		const language = optionalString(parsed.feed.dc?.languages?.[0]);
		return (parsed.feed.items ?? []).map((item) => rdfFeedItem(item, language));
	}
	const language = optionalString(parsed.feed.language);
	return (parsed.feed.items ?? []).map((item) => jsonFeedItem(item, language));
}

export async function loadFeedEntries(feedUrl: string): Promise<FeedItem[]> {
	const response = await fetchWithTimeout(feedUrl, {
		headers: {
			'User-Agent': WEB_FETCH_USER_AGENT,
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
		},
	});
	if (response.ok) return parseFeedItems(await readTextWithLimit(response, MAX_FEED_BYTES));

	const status = response.status;
	await response.body?.cancel();
	throw new Error(`RSS feed failed with HTTP ${status}: ${feedUrl}`);
}

function normalizeFeedItemUrl(value: string | undefined): string | null {
	const url = parseExternalHttpUrl(value);
	return url ? normalizeUrl(url.toString()) : null;
}

export function canonicalFeedItemUrl(item: FeedItem): string | null {
	const hackerNewsId = extractHackerNewsId(item.id);
	return normalizeFeedItemUrl(hackerNewsId ? `https://news.ycombinator.com/item?id=${hackerNewsId}` : item.link);
}

export function feedPublishedDate(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function feedSummary(value: string | undefined): string | null {
	if (!value) return null;
	const summary = decode(value.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
	return summary ? summary.slice(0, FEED_SUMMARY_MAX_CHARS) : null;
}
