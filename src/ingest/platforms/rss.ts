import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/monitored-source';
import { admitDiscoveredSourceResources, type SourceResourceDraft } from '@ingest/processing-jobs';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadFeed } from './rss-feed';

const FEED_CONCURRENCY = 4;

async function processFeed(env: CoreEnv, db: NodePgDatabase, feed: MonitoredSource): Promise<void> {
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
		sourceAvatarUrl: feed.avatarUrl,
	}));
	const outcomes = await admitDiscoveredSourceResources(env, drafts);
	let created = 0;
	let deduplicated = 0;
	for (const outcome of outcomes) {
		if (outcome === 'created') created++;
		else deduplicated++;
	}
	console.info({
		tag: 'RSS',
		msg: 'Feed processed',
		feed: feed.name,
		created,
		deduplicated,
		totalCount: itemCount,
	});
	await markSourcesScraped(db, [feed.id]);
}

export async function handleRSSCron(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	// Every feed source uses the same parser. A YouTube channel handle is an Atom
	// feed URL, so there is nothing for a separate monitor to do.
	// Its entries still resolve to resource_platform='youtube' at acquisition.
	const feeds = await loadMonitoredSources(db, 'feed');
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
