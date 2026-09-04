import { type FeedEntry as ExtractedFeedEntry, extractFromJson, extractFromXml, type FeedData } from '@extractus/feed-extractor';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { limitByteStream } from '../../shared/response';
import { resolvePlatformResourceUrl } from '../acquisition';
import { markSourcesScraped, recordSourceFailure } from '../source-monitor-state';
import { enqueueSourceDrafts } from '../workflow';
import { canonicalizeWebResourceUrl } from './web';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;
const RSS_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FEED_CONCURRENCY = 4;

type FeedEntry = {
	url: string;
	summary: string | null;
	publishedDate: Date | null;
	originalLang?: string;
};

type MonitoredFeedSource = {
	id: string;
	name: string;
	handle: string;
};

function feedEntryUrl(item: ExtractedFeedEntry): string | null {
	const itemUrl = item.link ? URL.parse(item.link) : null;
	const itemPlatform =
		itemUrl && (itemUrl.protocol === 'http:' || itemUrl.protocol === 'https:') && !itemUrl.username && !itemUrl.password
			? resolvePlatformResourceUrl(itemUrl)
			: null;
	// Keep this admission policy on the raw monitored-feed link. YouTube
	// canonicalization turns /shorts/:id into /watch?v=:id and erases the signal.
	if (itemPlatform?.resourcePlatform === 'youtube' && itemUrl?.pathname.startsWith('/shorts/')) return null;

	const idUrl = URL.parse(item.id);
	if (idUrl && (idUrl.protocol === 'http:' || idUrl.protocol === 'https:') && !idUrl.username && !idUrl.password) {
		const platform = resolvePlatformResourceUrl(idUrl);
		if (platform) return platform.canonicalUrl;
	}

	if (!itemUrl || (itemUrl.protocol !== 'http:' && itemUrl.protocol !== 'https:') || itemUrl.username || itemUrl.password) return null;
	if (itemPlatform) return itemPlatform.canonicalUrl;

	return canonicalizeWebResourceUrl(itemUrl);
}

function normalizeFeedEntries(items: ExtractedFeedEntry[], feedLanguage?: string): FeedEntry[] {
	const entries = new Map<string, FeedEntry>();
	for (const item of items) {
		const url = feedEntryUrl(item);
		if (!url || entries.has(url)) continue;
		const date = item.published ? new Date(item.published) : null;
		entries.set(url, {
			url,
			summary: item.description?.slice(0, FEED_SUMMARY_MAX_CHARS) || null,
			publishedDate: date && !Number.isNaN(date.getTime()) ? date : null,
			originalLang: feedLanguage,
		});
	}
	return [...entries.values()];
}

async function loadFeed(feedUrl: string): Promise<{
	itemCount: number;
	entries: FeedEntry[];
}> {
	const requestedUrl = URL.parse(feedUrl);
	if (
		!requestedUrl ||
		(requestedUrl.protocol !== 'http:' && requestedUrl.protocol !== 'https:') ||
		requestedUrl.username ||
		requestedUrl.password
	) {
		throw new Error('Enter a valid feed URL (http/https).');
	}
	const response = await fetch(requestedUrl, {
		headers: {
			'User-Agent': RSS_FETCH_USER_AGENT,
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Feed fetch failed with HTTP ${status}.`);
	}
	const effectiveUrl = URL.parse(response.url);
	if (
		!effectiveUrl ||
		(effectiveUrl.protocol !== 'http:' && effectiveUrl.protocol !== 'https:') ||
		effectiveUrl.username ||
		effectiveUrl.password
	) {
		await response.body?.cancel();
		throw new Error('Feed redirected to an invalid URL.');
	}

	let parsed: FeedData;
	try {
		const body = response.body && limitByteStream(response.body, MAX_FEED_BYTES, () => new Error(`Feed exceeded ${MAX_FEED_BYTES} bytes`));
		const content = await new Response(body).text();
		const parserOptions = {
			baseUrl: effectiveUrl.toString(),
			descriptionMaxLen: FEED_SUMMARY_MAX_CHARS,
		};
		parsed =
			response.headers.get('content-type')?.toLowerCase().includes('json') || content.trimStart().startsWith('{')
				? extractFromJson(content, parserOptions)
				: extractFromXml(content, parserOptions);
	} catch {
		throw new Error('URL did not return a readable feed.');
	}
	const items = (parsed.entries ?? []).slice(0, MAX_FEED_ITEMS);
	const entries = normalizeFeedEntries(items, parsed.language?.trim() || undefined);
	return {
		itemCount: items.length,
		entries,
	};
}

async function processFeed(env: CoreEnv, db: NodePgDatabase, feed: MonitoredFeedSource): Promise<void> {
	const { entries, itemCount } = await loadFeed(feed.handle);
	const skipped = itemCount - entries.length;
	if (skipped) console.warn({ tag: 'RSS', msg: 'Skipped invalid or duplicate feed items', feed: feed.name, count: skipped });
	if (!entries.length) {
		console.info({ tag: 'RSS', msg: itemCount ? 'Feed has no valid item URLs' : 'Feed has no items', feed: feed.name });
		await markSourcesScraped(db, [feed.id]);
		return;
	}

	const drafts = entries.map((item) => ({
		sourceId: feed.id,
		url: item.url,
		publishedDate: item.publishedDate,
		summary: item.summary,
		originalLang: item.originalLang,
	}));
	const created = await enqueueSourceDrafts(env, db, drafts);
	console.info({
		tag: 'RSS',
		msg: 'Feed processed',
		feed: feed.name,
		created,
		deduplicated: drafts.length - created,
		totalCount: itemCount,
	});
	await markSourcesScraped(db, [feed.id]);
}

export async function handleRSSCron(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	// Every feed source uses the same parser. A YouTube channel handle is an Atom
	// feed URL, so there is nothing for a separate monitor to do.
	// Its entries still resolve to resource_platform='youtube' at acquisition.
	const { rows: feeds } = await db.execute<MonitoredFeedSource>(sql`
		SELECT id::text AS id, name, handle
		FROM sources
		WHERE enabled = true
		  AND monitor_kind = 'feed'
		  AND (handle NOT LIKE 'https://www.youtube.com/feeds/videos.xml?channel_id=%'
		    OR scraped_at IS NULL
		    OR scraped_at < NOW() - INTERVAL '30 minutes')
	`);
	for (let index = 0; index < feeds.length; index += FEED_CONCURRENCY) {
		const batch = feeds.slice(index, index + FEED_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((feed) => processFeed(env, db, feed)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'fulfilled') continue;
			const failedFeed = batch[resultIndex];
			if (!failedFeed) continue;
			console.error({
				tag: 'RSS',
				msg: 'Feed processing failed',
				feed: failedFeed.name,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
			await recordSourceFailure(db, failedFeed.id, result.reason);
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
