import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { resolvePlatformResourceUrl } from '../acquisition';
import { markSourcesScraped, recordSourceFailure } from '../source-monitor-state';
import { enqueueSourceDrafts, type SourceResourceDraft } from '../workflow';
import { loadFeed } from './rss-feed';

const FEED_CONCURRENCY = 4;

type FeedSource = {
	id: string;
	name: string;
	handle: string;
	avatarUrl: string | null;
};

export async function resolveFeedMonitoredSource(url: URL) {
	const { effectiveUrl: feedUrl, title } = await loadFeed(url.toString(), resolvePlatformResourceUrl);
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
		SELECT id::text AS id, name, handle, avatar_url AS "avatarUrl"
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
	const { entries, itemCount } = await loadFeed(feed.handle, resolvePlatformResourceUrl);
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
		sourceAvatarUrl: feed.avatarUrl,
	}));
	const created = await enqueueSourceDrafts(env, drafts);
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
