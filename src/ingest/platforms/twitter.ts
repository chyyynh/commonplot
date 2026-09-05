import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { markSourcesScraped, recordSourceFailure } from '../source-monitor-state';
import { enqueueSourceDrafts, type SourceResourceDraft } from '../workflow';
import { parseTwitterAdvancedSearchPage, type Tweet } from './twitter-data';

// Twitter Monitor

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

const TWITTER_SOURCE_CONCURRENCY = 5;

type TwitterSource = {
	id: string;
	name: string;
	handle: string;
	scrapedAt: Date | null;
	createdAt: Date;
};

async function loadTwitterSources(db: NodePgDatabase): Promise<TwitterSource[]> {
	const result = await db.execute<TwitterSource>(sql`
		SELECT
			id::text AS id,
			name,
			handle,
			scraped_at AS "scrapedAt",
			created_at AS "createdAt"
		FROM sources
		WHERE enabled = true AND monitor_kind = 'twitter'
	`);
	return result.rows;
}

/** Fetch one fixed monitoring window using twitterapi.io's native cursor. */
async function fetchTweetsForSource(apiKey: string, userName: string, sinceTime: number, untilTime: number) {
	const normalizedUserName = userName.replace(/^@/, '').trim().toLowerCase();
	if (!/^[a-z0-9_]{1,15}$/.test(normalizedUserName)) throw new Error('Twitter source has an invalid handle');
	if (!Number.isSafeInteger(sinceTime) || !Number.isSafeInteger(untilTime) || sinceTime < 0 || sinceTime >= untilTime) {
		throw new Error('Twitter monitor has an invalid time window');
	}
	const query = `from:${normalizedUserName} include:nativeretweets -filter:replies since_time:${sinceTime} until_time:${untilTime}`;
	const terminalTweets = new Map<string, Tweet>();
	const seenCursors = new Set<string>();
	let providerTweets = 0;
	let pages = 0;
	let skippedItems = 0;
	let cursor: string | null = null;

	while (true) {
		const params = new URLSearchParams({ query, queryType: 'Latest' });
		if (cursor) params.set('cursor', cursor);

		const response = await fetch(`${TWITTER_ADVANCED_SEARCH_API}?${params}`, {
			headers: { 'x-api-key': apiKey },
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Twitter Advanced Search failed with HTTP ${response.status}`);
		}
		const apiRes = parseTwitterAdvancedSearchPage(await response.json());
		pages++;
		providerTweets += apiRes.rawTweetCount;
		skippedItems += apiRes.invalidItems.length;
		for (const item of apiRes.invalidItems) {
			console.error({
				tag: 'TWITTER',
				event: 'twitter_provider_item_skipped',
				userName,
				page: pages,
				item_index: item.index,
				error: item.message,
			});
		}
		for (const tweet of apiRes.tweets) terminalTweets.set(tweet.id?.trim() || tweet.url, tweet);
		if (!apiRes.hasNextPage) break;
		if (!apiRes.nextCursor) throw new Error(`Twitter Advanced Search omitted the next cursor for @${userName}`);
		if (seenCursors.has(apiRes.nextCursor)) throw new Error(`Twitter Advanced Search repeated its cursor for @${userName}`);
		seenCursors.add(apiRes.nextCursor);
		cursor = apiRes.nextCursor;
	}
	console.info({
		tag: 'TWITTER',
		event: 'twitter_search_completed',
		userName,
		pages,
		provider_tweets: providerTweets,
		unique_tweets: terminalTweets.size,
		skipped_items: skippedItems,
	});
	return { tweets: terminalTweets.values(), providerTweets, pages, skippedItems };
}

async function enqueueTweets(env: CoreEnv, db: NodePgDatabase, tweets: Iterable<Tweet>, source: TwitterSource) {
	const drafts = new Map<string, SourceResourceDraft>();
	let skippedItems = 0;
	let normalizedTweets = 0;
	for (const carrier of tweets) {
		const tweet = carrier.retweeted_tweet ?? carrier;
		let stage = 'normalization';
		try {
			if (carrier.retweeted_tweet) {
				if (!carrier.author?.userName.trim()) throw new Error(`Retweet ${carrier.id ?? carrier.url} has no complete author`);
				if (!tweet.author?.name.trim() || !tweet.author.userName.trim()) {
					throw new Error(`Retweeted tweet ${tweet.id ?? tweet.url} has no complete author`);
				}
			} else if (tweet.text.startsWith('RT @')) {
				// A missing nested retweet keeps its carrier URL for acquisition to resolve.
				console.warn({ tag: 'TWITTER', event: 'twitter_retweet_carrier_preserved', tweetId: tweet.id, url: tweet.url });
			} else if (!tweet.author?.name.trim() || !tweet.author.userName.trim()) {
				throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
			}
			const attributedAuthor = carrier.retweeted_tweet
				? carrier.author?.userName
				: carrier.retweetedBy?.authorUserName || carrier.author?.userName;
			const userName = attributedAuthor?.trim().toLowerCase() || null;
			if (userName !== source.handle) {
				throw new Error(`Tweet ${tweet.id ?? tweet.url} was attributed to @${userName ?? 'unknown'}, expected @${source.handle}`);
			}
			normalizedTweets++;
			stage = 'draft';
			const tweetId = tweet.id?.trim();
			if (!tweetId || !/^\d+$/.test(tweetId)) throw new Error(`Tweet ${tweet.url} has no valid provider id`);
			const url = `https://x.com/i/status/${tweetId}`;
			const publishedDate = new Date(tweet.createdAt);
			if (Number.isNaN(publishedDate.getTime())) throw new Error(`Tweet ${tweet.id ?? url} has invalid publishedDate`);
			drafts.set(url, {
				sourceId: source.id,
				url,
				publishedDate,
				summary: null,
				originalLang: tweet.lang,
				keywords: tweet.hashTags,
			});
		} catch (error) {
			skippedItems++;
			console.error({
				tag: 'TWITTER',
				event: 'twitter_item_skipped',
				stage,
				userName: source.handle,
				tweetId: tweet.id,
				url: tweet.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const pending = [...drafts.values()];
	const created = pending.length ? await enqueueSourceDrafts(env, db, pending) : 0;
	return { admittedDrafts: pending.length, created, deduplicated: pending.length - created, normalizedTweets, skippedItems };
}

type TwitterSourceMetrics = Awaited<ReturnType<typeof processTwitterSource>>;

async function processTwitterSource(env: CoreEnv, db: NodePgDatabase, source: TwitterSource, windowEnd: Date) {
	const sinceTime = Math.floor(new Date(source.scrapedAt ?? source.createdAt).getTime() / 1000);
	const untilTime = Math.floor(windowEnd.getTime() / 1000);
	try {
		const fetched = await fetchTweetsForSource(env.KAITO_API_KEY, source.handle, sinceTime, untilTime);
		const admission = await enqueueTweets(env, db, fetched.tweets, source);
		const metrics = {
			admittedDrafts: admission.admittedDrafts,
			created: admission.created,
			deduplicated: admission.deduplicated,
			normalizedTweets: admission.normalizedTweets,
			pages: fetched.pages,
			providerTweets: fetched.providerTweets,
			skippedItems: fetched.skippedItems + admission.skippedItems,
			sourceId: source.id,
		};
		console.info({
			tag: 'TWITTER',
			event: 'twitter_source_processed',
			userName: source.handle,
			since_time: sinceTime,
			until_time: untilTime,
			pages: metrics.pages,
			provider_tweets: metrics.providerTweets,
			normalized_tweets: metrics.normalizedTweets,
			admitted_drafts: metrics.admittedDrafts,
			skipped_items: metrics.skippedItems,
			created: metrics.created,
			deduplicated: metrics.deduplicated,
		});
		return metrics;
	} catch (error) {
		await recordSourceFailure(db, source.id, error);
		console.error({
			tag: 'TWITTER',
			event: 'twitter_source_failed',
			userName: source.handle,
			since_time: sinceTime,
			until_time: untilTime,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

async function processTwitterSources(env: CoreEnv, db: NodePgDatabase, sources: TwitterSource[], windowEnd: Date) {
	const completed: TwitterSourceMetrics[] = [];
	const systemFailures: unknown[] = [];
	for (let offset = 0; offset < sources.length; offset += TWITTER_SOURCE_CONCURRENCY) {
		const group = sources.slice(offset, offset + TWITTER_SOURCE_CONCURRENCY);
		const results = await Promise.allSettled(group.map((source) => processTwitterSource(env, db, source, windowEnd)));
		for (const result of results) {
			if (result.status === 'fulfilled') completed.push(result.value);
			else systemFailures.push(result.reason);
		}
	}

	const completedSourceIds = completed.map(({ sourceId }) => sourceId);
	let advancedSources = 0;
	let watermarkFailures = 0;
	if (completedSourceIds.length) {
		try {
			advancedSources = await markSourcesScraped(db, completedSourceIds, windowEnd);
		} catch (error) {
			watermarkFailures = completedSourceIds.length;
			systemFailures.push(error);
			console.error({
				tag: 'TWITTER',
				event: 'twitter_watermark_update_failed',
				sources: completedSourceIds.length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const totals = {
		admittedDrafts: 0,
		created: 0,
		deduplicated: 0,
		normalizedTweets: 0,
		pages: 0,
		providerTweets: 0,
		skippedItems: 0,
	};
	for (const metrics of completed) {
		totals.admittedDrafts += metrics.admittedDrafts;
		totals.created += metrics.created;
		totals.deduplicated += metrics.deduplicated;
		totals.normalizedTweets += metrics.normalizedTweets;
		totals.pages += metrics.pages;
		totals.providerTweets += metrics.providerTweets;
		totals.skippedItems += metrics.skippedItems;
	}
	return {
		...totals,
		advancedSources,
		incompleteSources: sources.length - completed.length + watermarkFailures,
		supersededSources: completedSourceIds.length - advancedSources - watermarkFailures,
		systemFailures,
	};
}

export async function handleTwitterCron(env: CoreEnv, windowEnd: Date = new Date()): Promise<void> {
	if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
	if (!Number.isFinite(windowEnd.getTime())) throw new Error('Twitter monitor window end is invalid');
	const db = await connectCoreDb(env);
	console.info({ tag: 'TWITTER', msg: 'start', window_end: windowEnd.toISOString() });
	const sources = await loadTwitterSources(db);
	if (!sources.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
		return;
	}

	const groups = Math.ceil(sources.length / TWITTER_SOURCE_CONCURRENCY);
	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', sources: sources.length, groups });
	const outcome = await processTwitterSources(env, db, sources, windowEnd);

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		sources: sources.length,
		groups,
		provider_tweets: outcome.providerTweets,
		normalized_tweets: outcome.normalizedTweets,
		skipped_items: outcome.skippedItems,
		pages: outcome.pages,
		admitted_drafts: outcome.admittedDrafts,
		created: outcome.created,
		deduplicated: outcome.deduplicated,
		advanced_sources: outcome.advancedSources,
		superseded_sources: outcome.supersededSources,
		incomplete_sources: outcome.incompleteSources,
	});
	if (outcome.systemFailures.length) {
		throw new AggregateError(outcome.systemFailures, `${outcome.systemFailures.length} Twitter monitor operations failed`);
	}
}
