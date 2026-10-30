import { extractFromJson, extractFromXml } from '@extractus/feed-extractor';
import { fromHtml } from 'hast-util-from-html';
import { toText } from 'hast-util-to-text';
import { z } from 'zod';
import type { MonitorAdapter } from '.';
import { cleanText } from '../contracts/markdown';
import type { SourceResourceDraft } from '../contracts/processing-target';
import { resolveResourceUrl, ResourceUrlSchema } from '../contracts/resource-url';
import { fetchOk, readBoundedResponseText } from '../services/response';

const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;
const RSS_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** What a feed last answered with, sent back so an unchanged feed answers 304. */
const FeedStateSchema = z.object({ etag: z.string().optional(), lastModified: z.string().optional() });
type FeedState = z.infer<typeof FeedStateSchema>;
type FeedEntry = Readonly<{ id?: string; link?: string; description?: string; published?: string }>;

/** The feed's latest entries and new validators; null when it answered 304. */
async function readFeed(url: string, state: FeedState): Promise<{ entries: FeedEntry[]; state: FeedState } | null> {
	const requestedUrl = ResourceUrlSchema.safeParse(url).data;
	if (!requestedUrl) {
		throw new Error('Enter a valid feed URL (http/https).');
	}
	const response = await fetchOk(requestedUrl, {
		label: 'Feed fetch',
		timeoutMs: 15_000,
		missing: [304],
		headers: {
			'User-Agent': RSS_FETCH_USER_AGENT,
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
			...(state.etag ? { 'If-None-Match': state.etag } : {}),
			...(state.lastModified ? { 'If-Modified-Since': state.lastModified } : {}),
		},
	});
	if (!response) return null;
	const content = await readBoundedResponseText(response, MAX_FEED_BYTES, 'Feed');
	const parserOptions = {
		baseUrl: response.url,
		getExtraEntryFields: (entry: Record<string, unknown>) => ({ description: feedEntryDescription(entry) }),
	};
	const parsed =
		response.headers.get('content-type')?.toLowerCase().includes('json') || content.trimStart().startsWith('{')
			? extractFromJson(content, parserOptions)
			: extractFromXml(content, parserOptions);
	return {
		entries: (parsed.entries ?? []).slice(0, MAX_FEED_ITEMS),
		state: { etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined },
	};
}

/** An entry's draft, by the platform identity in its id when it has one; a feed description only fills in for a generic page. */
function feedEntryDraft(entry: FeedEntry): SourceResourceDraft | null {
	const id = resolveResourceUrl(entry.id);
	const url = id?.resourcePlatform ? id : resolveResourceUrl(entry.link);
	if (!url) return null;
	return {
		url: url.url,
		sourceHints: {
			summary: (!url.resourcePlatform && entry.description) || undefined,
			publishedDate: entry.published || undefined,
		},
	};
}

function feedFieldText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const node = value as Record<string, unknown>;
		const text = node._text ?? node['#text'] ?? node._cdata ?? node.$t;
		if (typeof text === 'string') return text;
	}
	return '';
}

/**
 * The extractor strips tags without a separator, gluing adjacent blocks
 * ("Thomas KwaConstellation"). innerText-style extraction separates blocks and skips scripts.
 */
function feedEntryDescription(entry: Record<string, unknown>): string {
	const html = [entry.description, entry.summary, entry['content:encoded'], entry.content, entry.content_text, entry.content_html]
		.map(feedFieldText)
		.find((value) => value.trim());
	if (!html) return '';
	const text = cleanText(toText(fromHtml(html, { fragment: true })));
	if (text.length <= FEED_SUMMARY_MAX_CHARS) return text;
	const cut = text.slice(0, FEED_SUMMARY_MAX_CHARS);
	const wordEnd = cut.lastIndexOf(' ');
	return `${(wordEnd > FEED_SUMMARY_MAX_CHARS * 0.8 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
}

/** A monitor that reads one feed per check, keeping the entries `keep` accepts. */
function feedReader(
	concurrency: number,
	feedUrl: (locator: string) => string,
	keep: (entry: FeedEntry) => boolean = () => true,
): MonitorAdapter<FeedState> {
	return {
		stateSchema: FeedStateSchema,
		interval: { min: 5 * 60, max: 2 * 60 * 60 },
		concurrency,
		async poll(_env, monitor) {
			const feed = await readFeed(feedUrl(monitor.locator), monitor.state);
			if (!feed) return { drafts: [], skipped: 0, state: monitor.state, details: { not_modified: true } };
			const drafts = feed.entries.flatMap((entry) => (keep(entry) ? (feedEntryDraft(entry) ?? []) : []));
			return { drafts, skipped: feed.entries.length - drafts.length, state: feed.state, details: { entries: feed.entries.length } };
		},
	};
}

/** An RSS, Atom or JSON feed, located by its URL. */
export const feedMonitor = feedReader(4, (url) => url);

/** A YouTube channel, located by its channel id and read through the channel's Atom feed, without its Shorts. */
export const youtubeMonitor = feedReader(
	2,
	(channelId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
	(entry) => {
		// Check the entry's link before canonical identity erases the Shorts path.
		const link = resolveResourceUrl(entry.link);
		return !link || !new URL(link.url).pathname.startsWith('/shorts/');
	},
);
