import { resourceIdentityForDetectedPlatform } from '@core-shared/resource-types';
import { detectResourceUrl } from '@core-shared/url';
import type { SourceResourceDraft } from '@ingest/domain/resource-admission-store';
import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/domain/source-store';
import { admitDiscoveredSourceResources } from '@ingest/resource-admission';
import { loadFeed } from './rss-feed';

const FEED_CONCURRENCY = 4;

async function processFeed(env: CoreEnv, feed: MonitoredSource): Promise<void> {
	const { entries, itemCount } = await loadFeed(feed.handle);
	const skipped = itemCount - entries.length;
	if (skipped) console.warn({ tag: 'RSS', msg: 'Skipped invalid or duplicate feed items', feed: feed.name, count: skipped });
	if (!entries.length) {
		console.info({ tag: 'RSS', msg: itemCount ? 'Feed has no valid item URLs' : 'Feed has no items', feed: feed.name });
		await markSourcesScraped(env, [feed.id]);
		return;
	}

	const drafts: SourceResourceDraft[] = [];
	for (const item of entries) {
		try {
			if (!item.title) throw new Error(`RSS item from ${feed.name} has no title: ${item.url}`);
			const detected = detectResourceUrl(item.url);
			drafts.push({
				sourceId: feed.id,
				url: item.url,
				title: item.title,
				publishedDate: item.publishedDate,
				summary: item.summary,
				...(detected
					? resourceIdentityForDetectedPlatform(detected.resourcePlatform)
					: ({ kind: 'blog', resourcePlatform: null } as const)),
				originalLang: item.originalLang,
			});
		} catch (error) {
			console.error({
				tag: 'RSS',
				msg: 'Item discovery failed',
				url: item.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const outcomes = await admitDiscoveredSourceResources(env, drafts);
	let created = 0;
	let existing = 0;
	let retried = 0;
	for (const [index, outcome] of outcomes.entries()) {
		if (outcome.status === 'rejected') {
			console.error({
				tag: 'RSS',
				msg: 'Resource discovery admission failed',
				url: drafts[index]?.url,
				error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
			});
			continue;
		}
		if (outcome.value === 'created') created++;
		else if (outcome.value === 'retried') retried++;
		else existing++;
	}
	console.info({
		tag: 'RSS',
		msg: 'Feed processed',
		feed: feed.name,
		created,
		existing,
		retried,
		totalCount: itemCount,
	});
	await markSourcesScraped(env, [feed.id]);
}

export async function handleRSSCron(env: CoreEnv): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	// Every feed-discovered source, whatever its platform says: a YouTube channel
	// handle is an Atom feed URL, so there is nothing for a separate monitor to do.
	// Its entries still resolve to resource_platform='youtube' at acquisition.
	const feeds = await loadMonitoredSources(env, 'feed');
	for (let index = 0; index < feeds.length; index += FEED_CONCURRENCY) {
		const batch = feeds.slice(index, index + FEED_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((feed) => processFeed(env, feed)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'rejected') {
				console.error({
					tag: 'RSS',
					msg: 'Feed processing failed',
					feed: batch[resultIndex]?.name,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
				const failedFeed = batch[resultIndex];
				if (failedFeed) await recordSourceFailure(env, failedFeed.id, result.reason);
			}
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
