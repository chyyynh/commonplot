import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { parseFeed } from 'feedsmith';
import { decode } from 'html-entities';
import { resolvePlatformResourceUrl } from '../acquisition';
import { markSourcesScraped, recordSourceFailure } from '../source-monitor-state';
import { enqueueSourceDrafts, type SourceResourceDraft } from '../workflow';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;
const RSS_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];
const FEED_CONCURRENCY = 4;

type ParsedFeed = ReturnType<typeof parseFeed>;
type RawFeedItem = {
	id: string;
	link?: string;
	summary?: string;
	published?: string;
	language?: string;
};

type FeedEntry = {
	url: string;
	summary: string | null;
	publishedDate: Date | null;
	originalLang?: string;
};

type FeedSource = {
	id: string;
	name: string;
	handle: string;
};

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function feedItems(parsed: ParsedFeed): RawFeedItem[] {
	if (parsed.format === 'rss') {
		const language = optionalString(parsed.feed.language);
		return (parsed.feed.items ?? []).map((item) => {
			const itemLink = optionalString(item.link);
			const guid = optionalString(item.guid?.value);
			const link = item.guid?.isPermaLink !== false && guid?.match(/^https?:\/\//i) ? guid : itemLink;
			return {
				id: guid ?? link ?? '',
				link,
				summary: optionalString(item.description),
				published: optionalString(item.pubDate) ?? optionalString(item.dc?.dates?.[0]),
				language,
			};
		});
	}
	if (parsed.format === 'atom') {
		return (parsed.feed.entries ?? []).map((entry) => {
			const links = entry.links ?? [];
			const link =
				optionalString(links.find((candidate) => !candidate.rel || candidate.rel === 'alternate')?.href) ?? optionalString(links[0]?.href);
			return {
				id: optionalString(entry.id) ?? link ?? '',
				link,
				summary: optionalString(entry.summary),
				published: optionalString(entry.published) ?? optionalString(entry.updated),
				language: optionalString(entry.dc?.languages?.[0]),
			};
		});
	}
	if (parsed.format === 'rdf') {
		const language = optionalString(parsed.feed.dc?.languages?.[0]);
		return (parsed.feed.items ?? []).map((item) => {
			const link = optionalString(item.link);
			return {
				id: optionalString(item.rdf?.about) ?? link ?? '',
				link,
				summary: optionalString(item.description),
				published: optionalString(item.dc?.dates?.[0]),
				language,
			};
		});
	}
	const language = optionalString(parsed.feed.language);
	return (parsed.feed.items ?? []).map((item) => {
		const link = optionalString(item.url) ?? optionalString(item.external_url);
		return {
			id: optionalString(item.id) ?? link ?? '',
			link,
			summary: optionalString(item.summary),
			published: optionalString(item.date_published) ?? optionalString(item.date_modified),
			language: optionalString(item.language) ?? language,
		};
	});
}

function feedEntryUrl(item: RawFeedItem): string | null {
	const idUrl = URL.parse(item.id);
	if (idUrl && (idUrl.protocol === 'http:' || idUrl.protocol === 'https:') && !idUrl.username && !idUrl.password) {
		const platform = resolvePlatformResourceUrl(idUrl);
		if (platform) return platform.canonicalUrl;
	}

	const itemUrl = item.link ? URL.parse(item.link) : null;
	if (!itemUrl || (itemUrl.protocol !== 'http:' && itemUrl.protocol !== 'https:') || itemUrl.username || itemUrl.password) return null;
	const platform = resolvePlatformResourceUrl(itemUrl);
	if (platform) return platform.canonicalUrl;

	itemUrl.hostname = itemUrl.hostname.toLowerCase().replace(/^www\./, '');
	for (const parameter of TRACKING_PARAMS) itemUrl.searchParams.delete(parameter);
	itemUrl.searchParams.sort();
	return itemUrl.toString();
}

function normalizedFeedEntries(items: RawFeedItem[]): FeedEntry[] {
	const entries = new Map<string, FeedEntry>();
	for (const item of items) {
		const url = feedEntryUrl(item);
		if (!url || entries.has(url)) continue;
		const date = item.published ? new Date(item.published) : null;
		const summary = item.summary
			? decode(item.summary.replace(/<[^>]*>/g, ' '))
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, FEED_SUMMARY_MAX_CHARS) || null
			: null;
		entries.set(url, {
			url,
			summary,
			publishedDate: date && !Number.isNaN(date.getTime()) ? date : null,
			originalLang: item.language,
		});
	}
	return [...entries.values()];
}

async function loadFeed(feedUrl: string): Promise<{
	effectiveUrl: URL;
	title: string | null;
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

	let parsed: ParsedFeed;
	try {
		let feedBytes = 0;
		const body = response.body?.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					feedBytes += chunk.byteLength;
					if (feedBytes > MAX_FEED_BYTES) throw new Error(`Feed exceeded ${MAX_FEED_BYTES} bytes`);
					controller.enqueue(chunk);
				},
			}),
		);
		parsed = parseFeed(await new Response(body).text(), {
			maxItems: MAX_FEED_ITEMS,
		});
	} catch {
		throw new Error('URL did not return a readable feed.');
	}
	effectiveUrl.hash = '';
	effectiveUrl.hostname = effectiveUrl.hostname.toLowerCase();
	if (effectiveUrl.pathname.length > 1 && effectiveUrl.pathname.endsWith('/')) {
		effectiveUrl.pathname = effectiveUrl.pathname.slice(0, -1);
	}

	const items = feedItems(parsed);
	const entries = normalizedFeedEntries(items);
	const title = optionalString(parsed.feed.title);
	return {
		effectiveUrl,
		title: title ? decode(title).trim() || null : null,
		itemCount: items.length,
		entries,
	};
}

export async function resolveFeedMonitoredSource(url: URL) {
	const { effectiveUrl: feedUrl, title } = await loadFeed(url.toString());
	const feedHost = feedUrl.hostname.toLowerCase().replace(/^www\./, '');
	return {
		monitorKind: 'feed' as const,
		handle: feedUrl.toString(),
		name: title ?? feedHost,
		siteUrl: feedUrl.origin,
		avatarUrl: null,
	};
}

async function loadFeedSources(db: NodePgDatabase): Promise<FeedSource[]> {
	const result = await db.execute<FeedSource>(sql`
		SELECT id::text AS id, name, handle
		FROM sources
		WHERE enabled = true
		  AND monitor_kind = 'feed'
		  AND (handle NOT LIKE 'https://www.youtube.com/feeds/videos.xml?channel_id=%'
		    OR scraped_at IS NULL
		    OR scraped_at < NOW() - INTERVAL '30 minutes')
	`);
	return result.rows;
}

async function processFeed(env: CoreEnv, db: NodePgDatabase, feed: FeedSource): Promise<void> {
	const { entries, itemCount } = await loadFeed(feed.handle);
	const skipped = itemCount - entries.length;
	if (skipped) console.warn({ tag: 'RSS', msg: 'Skipped invalid or duplicate feed items', feed: feed.name, count: skipped });
	if (!entries.length) {
		console.info({ tag: 'RSS', msg: itemCount ? 'Feed has no valid item URLs' : 'Feed has no items', feed: feed.name });
		await markSourcesScraped(db, [feed.id]);
		return;
	}

	const drafts: SourceResourceDraft[] = entries.map((item) => ({
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
	const feeds = await loadFeedSources(db);
	for (let index = 0; index < feeds.length; index += FEED_CONCURRENCY) {
		const batch = feeds.slice(index, index + FEED_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((feed) => processFeed(env, db, feed)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'rejected') {
				console.error({
					tag: 'RSS',
					msg: 'Feed processing failed',
					feed: batch[resultIndex]?.name,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
				const failedFeed = batch[resultIndex];
				if (failedFeed) await recordSourceFailure(db, failedFeed.id, result.reason);
			}
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
