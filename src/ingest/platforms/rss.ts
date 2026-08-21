import { resourceIdentityForDetectedPlatform } from '@core-shared/resource-types';
import { detectResourceUrl, normalizeUrl } from '@core-shared/url';
import { withCoreDb } from '@db/client';
import { attachSourcesToResources, type ExistingResourceRecord, getExistingResourcesByUrl } from '@ingest/domain/resource-admission-store';
import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/domain/source-store';
import { admitPendingSourceResource, enqueueProcessing } from '@ingest/workflow';
import { type FeedEntry, loadFeed } from './rss-feed';

const FEED_CONCURRENCY = 4;
const ITEM_CONCURRENCY = 5;

async function enqueueFeedItem(env: CoreEnv, feed: MonitoredSource, item: FeedEntry): Promise<void> {
	if (!item.title) throw new Error(`RSS item from ${feed.name} has no title: ${item.url}`);
	const detected = detectResourceUrl(item.url);
	const identity = detected
		? resourceIdentityForDetectedPlatform(detected.resourcePlatform)
		: ({ kind: 'blog', resourcePlatform: null } as const);
	await admitPendingSourceResource(env, {
		sourceId: feed.id,
		url: item.url,
		title: item.title,
		publishedDate: item.publishedDate,
		summary: item.summary,
		...identity,
		originalLang: item.originalLang,
	});
}

/**
 * Claims rows that already existed before this feed was monitored — a saved URL,
 * or an entry that resolved to a special platform (Hacker News from hnrss,
 * YouTube from a channel feed). Only unowned rows are sent, so after the first cycle
 * this issues no statement at all.
 */
async function reattachFeedProvenance(env: CoreEnv, feed: MonitoredSource, existing: ExistingResourceRecord[]): Promise<void> {
	const unowned = existing.filter((resource) => resource.needsSourceAttach).map((resource) => resource.id);
	if (!unowned.length) return;
	await withCoreDb(env, (db) =>
		attachSourcesToResources(
			db,
			unowned.map((resourceId) => ({ resourceId, sourceId: feed.id })),
		),
	);
}

/** Runs `work` over `items` in bounded batches, isolating and logging each failure. */
async function enqueueInBatches<T>(items: T[], describe: (item: T) => string, msg: string, work: (item: T) => Promise<unknown>) {
	let done = 0;
	for (let index = 0; index < items.length; index += ITEM_CONCURRENCY) {
		const batch = items.slice(index, index + ITEM_CONCURRENCY);
		const results = await Promise.allSettled(batch.map(work));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				done++;
				continue;
			}
			console.error({
				tag: 'RSS',
				msg,
				url: describe(batch[resultIndex] as T),
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	return done;
}

async function processFeed(env: CoreEnv, feed: MonitoredSource): Promise<void> {
	const { entries, itemCount } = await loadFeed(feed.handle);
	const skipped = itemCount - entries.length;
	if (skipped) console.warn({ tag: 'RSS', msg: 'Skipped invalid or duplicate feed items', feed: feed.name, count: skipped });
	if (!entries.length) {
		console.info({ tag: 'RSS', msg: itemCount ? 'Feed has no valid item URLs' : 'Feed has no items', feed: feed.name });
		await markSourcesScraped(env, [feed.id]);
		return;
	}

	const existing = await withCoreDb(env, (db) =>
		getExistingResourcesByUrl(
			db,
			entries.map(({ url }) => url),
		),
	);
	await reattachFeedProvenance(env, feed, existing);

	const existingSet = new Set(existing.map((resource) => normalizeUrl(resource.url)));
	const newItems = entries.filter(({ url }) => !existingSet.has(url));
	const retryable = existing.filter((resource) => resource.shouldRetryEnrichment);
	const retried = await enqueueInBatches(
		retryable,
		(r) => r.url,
		'Existing resource retry enqueue failed',
		(r) => enqueueProcessing(env, r.id),
	);
	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, retried, totalCount: itemCount });

	const queued = await enqueueInBatches(
		newItems,
		({ url }) => url,
		'Item enqueue failed',
		(item) => enqueueFeedItem(env, feed, item),
	);
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
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
