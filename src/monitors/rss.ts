import { extractFromJson, extractFromXml } from '@extractus/feed-extractor';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { fromHtml } from 'hast-util-from-html';
import { toText } from 'hast-util-to-text';
import pLimit from 'p-limit';
import { cleanText } from '../contracts/markdown';
import { resolveResourceUrl, ResourceUrlSchema } from '../contracts/resource-url';
import { errorMessage, readBoundedResponseText } from '../services/response';
import { advanceSourceWatermark, type FeedValidators, listDueFeedSources, type MonitoredFeedSource } from '../store/sources';
import { enqueueSourceDrafts } from './source-drafts';

const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;
const RSS_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FEED_CONCURRENCY = 4;

/** The feed's new validators once its entries are admitted; undefined when it answered 304 and has nothing new. */
async function processFeed(db: NodePgDatabase, feed: MonitoredFeedSource): Promise<FeedValidators | undefined> {
	const requestedUrl = ResourceUrlSchema.safeParse(feed.handle).data;
	if (!requestedUrl) {
		throw new Error('Enter a valid feed URL (http/https).');
	}
	const response = await fetch(requestedUrl, {
		headers: {
			'User-Agent': RSS_FETCH_USER_AGENT,
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
			...(feed.etag ? { 'If-None-Match': feed.etag } : {}),
			...(feed.lastModified ? { 'If-Modified-Since': feed.lastModified } : {}),
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 304) {
		await response.body?.cancel();
		console.info({ tag: 'RSS', msg: 'Feed unchanged', feed: feed.name });
		return undefined;
	}
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Feed fetch failed with HTTP ${status}.`);
	}
	const content = await readBoundedResponseText(response, MAX_FEED_BYTES, 'Feed');
	const parserOptions = {
		baseUrl: response.url,
		getExtraEntryFields: (entry: Record<string, unknown>) => ({ description: feedEntryDescription(entry) }),
	};
	const parsed =
		response.headers.get('content-type')?.toLowerCase().includes('json') || content.trimStart().startsWith('{')
			? extractFromJson(content, parserOptions)
			: extractFromXml(content, parserOptions);
	const items = (parsed.entries ?? []).slice(0, MAX_FEED_ITEMS);
	const drafts = items.flatMap((item) => {
		const link = resolveResourceUrl(item.link);
		// Check the source link before canonical identity erases the Shorts path.
		if (link?.resourcePlatform === 'youtube' && new URL(link.url).pathname.startsWith('/shorts/')) return [];
		const id = resolveResourceUrl(item.id);
		const url = id?.resourcePlatform ? id : link;
		if (!url) return [];
		return [
			{
				url: url.url,
				sourceHints: {
					// Platform adapters own their text; a feed description only fills in for a generic page.
					summary: (!url.resourcePlatform && item.description) || undefined,
					publishedDate: item.published || undefined,
				},
			},
		];
	});
	const admission = await enqueueSourceDrafts(db, feed.id, drafts);
	console.info({
		tag: 'RSS',
		msg: 'Feed processed',
		feed: feed.name,
		...admission,
		skipped: items.length - drafts.length + admission.skipped,
		totalCount: items.length,
	});
	return { etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
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

export async function handleRSSCron(db: NodePgDatabase): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const feeds = await listDueFeedSources(db);
	const limit = pLimit(FEED_CONCURRENCY);
	// A failed poll still advances the watermark, so a flaky YouTube channel feed waits its 30-minute cadence; it keeps its
	// old validators, so the next poll reads the feed in full.
	const results = await Promise.allSettled(
		feeds.map((feed) =>
			limit(async () => {
				let validators: FeedValidators | undefined;
				try {
					validators = await processFeed(db, feed);
				} finally {
					await advanceSourceWatermark(db, feed.id, new Date(), validators);
				}
			}),
		),
	);
	let failed = 0;
	for (const [index, result] of results.entries()) {
		if (result.status === 'fulfilled') continue;
		failed++;
		console.error({
			tag: 'RSS',
			msg: 'Feed processing failed',
			feed: feeds[index]!.name,
			error: errorMessage(result.reason),
		});
	}

	console.info({ tag: 'RSS', msg: 'end', sources: feeds.length, failed_sources: failed });
}
