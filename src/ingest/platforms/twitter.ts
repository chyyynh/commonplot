import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { markSourcesScraped, recordSourceFailure } from '../source-monitor-state';
import { enqueueSourceDrafts, type SourceResourceDraft } from '../workflow';
import { parseTwitterProfileInput } from './twitter-acquisition';
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

export function resolveTwitterMonitoredSource(input: string, url: URL | null) {
	const host = url?.hostname.toLowerCase().replace(/^(www|m)\./, '');
	if (url && host !== 'x.com' && host !== 'twitter.com') return null;
	const handle = parseTwitterProfileInput(input, url)?.toLowerCase() ?? null;
	if (!handle) {
		if (url && (host === 'x.com' || host === 'twitter.com')) throw new Error('Enter a valid X/Twitter handle or profile URL.');
		return null;
	}
	return {
		monitorKind: 'twitter' as const,
		handle,
		name: `@${handle}`,
		siteUrl: `https://x.com/${handle}`,
		avatarUrl: null,
	};
}

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

function monitoredAuthorUserName(tweet: Tweet): string | null {
	const userName = tweet.retweetedBy?.authorUserName || tweet.author?.userName;
	return userName?.trim().toLowerCase() || null;
}

function normalizeRetweet(tweet: Tweet): Tweet {
	if (tweet.retweeted_tweet) {
		const retweeter = tweet.author;
		if (!retweeter?.userName.trim()) {
			throw new Error(`Retweet ${tweet.id ?? tweet.url} has no complete author`);
		}
		const normalized = {
			...tweet.retweeted_tweet,
			retweetedBy: {
				authorUserName: retweeter.userName,
			},
		};
		if (!normalized.author?.name.trim() || !normalized.author.userName.trim()) {
			throw new Error(`Retweeted tweet ${normalized.id ?? normalized.url} has no complete author`);
		}
		return normalized;
	}
	// Keep a carrier when the provider omits or changes its nested retweet
	// payload. Its canonical URL is fetched again by the Resource Workflow.
	if (tweet.text.startsWith('RT @')) {
		console.warn({ tag: 'TWITTER', event: 'twitter_retweet_carrier_preserved', tweetId: tweet.id, url: tweet.url });
		return tweet;
	}
	if (!tweet.author?.name.trim() || !tweet.author.userName.trim()) {
		throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
	}
	return tweet;
}

type TwitterSourceFetch = {
	tweets: Tweet[];
	providerTweets: number;
	pages: number;
	skippedItems: number;
};

function normalizeFetchedTweets(tweets: Tweet[], monitoredUserName: string): Pick<TwitterSourceFetch, 'skippedItems' | 'tweets'> {
	const normalizedTweets: Tweet[] = [];
	let skippedItems = 0;
	for (const tweet of tweets) {
		try {
			const normalized = normalizeRetweet(tweet);
			const attributedUserName = monitoredAuthorUserName(normalized);
			if (attributedUserName !== monitoredUserName) {
				throw new Error(
					`Tweet ${normalized.id ?? normalized.url} was attributed to @${attributedUserName ?? 'unknown'}, expected @${monitoredUserName}`,
				);
			}
			normalizedTweets.push(normalized);
		} catch (error) {
			skippedItems++;
			console.error({
				tag: 'TWITTER',
				event: 'twitter_item_skipped',
				stage: 'normalization',
				tweetId: tweet.id,
				userName: monitoredUserName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { tweets: normalizedTweets, skippedItems };
}

/** Fetch one fixed monitoring window using twitterapi.io's native cursor. */
async function fetchTweetsForSource(apiKey: string, userName: string, sinceTime: number, untilTime: number): Promise<TwitterSourceFetch> {
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
	const normalized = normalizeFetchedTweets([...terminalTweets.values()], userName);
	skippedItems += normalized.skippedItems;

	console.info({
		tag: 'TWITTER',
		event: 'twitter_search_completed',
		userName,
		pages,
		provider_tweets: providerTweets,
		normalized_tweets: normalized.tweets.length,
		skipped_items: skippedItems,
	});
	return { tweets: normalized.tweets, providerTweets, pages, skippedItems };
}

async function enqueueTweets(env: CoreEnv, db: NodePgDatabase, tweets: Tweet[], source: TwitterSource) {
	const drafts = new Map<string, SourceResourceDraft>();
	let skippedItems = 0;
	for (const tweet of tweets) {
		try {
			const userName = monitoredAuthorUserName(tweet);
			if (!userName) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no monitored author identity`);
			if (userName !== source.handle) throw new Error(`Tweet ${tweet.id ?? tweet.url} is not attributed to @${source.handle}`);
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
				stage: 'draft',
				userName: source.handle,
				tweetId: tweet.id,
				url: tweet.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const pending = [...drafts.values()];
	const created = pending.length ? await enqueueSourceDrafts(env, db, pending) : 0;
	return { admittedDrafts: pending.length, created, deduplicated: pending.length - created, skippedItems };
}

type TwitterSourceMetrics = {
	admittedDrafts: number;
	created: number;
	deduplicated: number;
	normalizedTweets: number;
	pages: number;
	providerTweets: number;
	skippedItems: number;
	sourceId: string;
};

async function processTwitterSource(
	env: CoreEnv,
	db: NodePgDatabase,
	source: TwitterSource,
	windowEnd: Date,
): Promise<TwitterSourceMetrics> {
	const sinceTime = Math.floor(new Date(source.scrapedAt ?? source.createdAt).getTime() / 1000);
	const untilTime = Math.floor(windowEnd.getTime() / 1000);
	try {
		const fetched = await fetchTweetsForSource(env.KAITO_API_KEY, source.handle, sinceTime, untilTime);
		const admission = await enqueueTweets(env, db, fetched.tweets, source);
		const metrics: TwitterSourceMetrics = {
			admittedDrafts: admission.admittedDrafts,
			created: admission.created,
			deduplicated: admission.deduplicated,
			normalizedTweets: fetched.tweets.length,
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
