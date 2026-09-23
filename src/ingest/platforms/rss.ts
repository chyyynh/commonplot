import { type FeedEntry as ExtractedFeedEntry, extractFromJson, extractFromXml } from '@extractus/feed-extractor';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readBoundedResponseText } from '../../shared/response';
import { enqueueSourceDrafts, type SourceResourceDraft } from '../admission';
import { resolveResourceUrl } from './resource-url';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_SUMMARY_MAX_CHARS = 500;
const RSS_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FEED_CONCURRENCY = 4;

type MonitoredFeedSource = {
	id: string;
	name: string;
	handle: string;
};

function feedEntryUrl(item: ExtractedFeedEntry) {
	const link = resolveResourceUrl(item.link);
	// Keep this admission policy on the raw monitored-feed link. YouTube
	// canonicalization turns /shorts/:id into /watch?v=:id and erases the signal.
	if (link?.resourcePlatform === 'youtube' && new URL(link.url).pathname.startsWith('/shorts/')) return null;
	const id = resolveResourceUrl(item.id);
	return id?.resourcePlatform ? id : link;
}

function createFeedDrafts(items: ExtractedFeedEntry[], feedLanguage?: string) {
	const entries = new Map<string, SourceResourceDraft>();
	for (const item of items) {
		const url = feedEntryUrl(item);
		if (!url || entries.has(url.normalizedUrl)) continue;
		entries.set(url.normalizedUrl, {
			url: url.url,
			sourceHints: {
				summary: item.description || undefined,
				publishedDate: item.published || undefined,
				originalLang: feedLanguage,
			},
		});
	}
	return [...entries.values()];
}

async function processFeed(env: CoreEnv, db: NodePgDatabase, feed: MonitoredFeedSource): Promise<void> {
	const requestedUrl = resolveResourceUrl(feed.handle)?.url;
	if (!requestedUrl) {
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
	const effectiveUrl = resolveResourceUrl(response.url)?.url;
	if (!effectiveUrl) {
		await response.body?.cancel();
		throw new Error('Feed redirected to an invalid URL.');
	}

	const content = await readBoundedResponseText(response, MAX_FEED_BYTES, 'Feed');
	const parserOptions = {
		baseUrl: effectiveUrl,
		descriptionMaxLen: FEED_SUMMARY_MAX_CHARS,
	};
	const parsed =
		response.headers.get('content-type')?.toLowerCase().includes('json') || content.trimStart().startsWith('{')
			? extractFromJson(content, parserOptions)
			: extractFromXml(content, parserOptions);
	const items = (parsed.entries ?? []).slice(0, MAX_FEED_ITEMS);
	const drafts = createFeedDrafts(items, parsed.language?.trim() || undefined);
	const skipped = items.length - drafts.length;
	if (skipped) console.warn({ tag: 'RSS', msg: 'Skipped invalid or duplicate feed items', feed: feed.name, count: skipped });

	const admission = await enqueueSourceDrafts(env, db, feed.id, drafts);
	console.info({
		tag: 'RSS',
		msg: 'Feed processed',
		feed: feed.name,
		...admission,
		skipped: skipped + admission.skipped,
		totalCount: items.length,
	});
	const scrapedAt = new Date();
	await db.execute(sql`
		UPDATE sources
		SET scraped_at = ${scrapedAt}, updated_at = NOW()
		WHERE id = ${feed.id}::uuid
		  AND (scraped_at IS NULL OR scraped_at <= ${scrapedAt})
	`);
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
	const failures: unknown[] = [];
	for (let index = 0; index < feeds.length; index += FEED_CONCURRENCY) {
		const batch = feeds.slice(index, index + FEED_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((feed) => processFeed(env, db, feed)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'fulfilled') continue;
			const failedFeed = batch[resultIndex];
			failures.push(result.reason);
			console.error({
				tag: 'RSS',
				msg: 'Feed processing failed',
				feed: failedFeed.name,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}

	console.info({ tag: 'RSS', msg: 'end', sources: feeds.length, failed_sources: failures.length });
	if (failures.length) throw new AggregateError(failures, `${failures.length} feed monitor operations failed`);
}
