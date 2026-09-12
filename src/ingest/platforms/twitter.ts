import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../../shared/db';
import { enqueueSourceDrafts, type SourceResourceDraft } from '../admission';
import { parseTwitterAdvancedSearchPage, type Tweet } from './twitter-data';

// Twitter Monitor

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

const TWITTER_SOURCE_CONCURRENCY = 5;

type TwitterSource = {
	id: string;
	handle: string;
	scrapedAt: Date | null;
	createdAt: Date;
};

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
				url,
				sourceHints: { publishedDate: publishedDate.toISOString(), originalLang: tweet.lang, keywords: tweet.hashTags },
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
	const created = await enqueueSourceDrafts(env, db, source.id, pending);
	return { admittedDrafts: pending.length, created, deduplicated: pending.length - created, normalizedTweets, skippedItems };
}

async function processTwitterSource(env: CoreEnv, db: NodePgDatabase, source: TwitterSource, windowEnd: Date) {
	const sinceTime = Math.floor(new Date(source.scrapedAt ?? source.createdAt).getTime() / 1000);
	const untilTime = Math.floor(windowEnd.getTime() / 1000);
	try {
		const fetched = await fetchTweetsForSource(env.KAITO_API_KEY, source.handle, sinceTime, untilTime);
		const admission = await enqueueTweets(env, db, fetched.tweets, source);
		const updated = await db.execute(sql`
			UPDATE sources
			SET scraped_at = ${windowEnd}, updated_at = NOW()
			WHERE id = ${source.id}::uuid
			  AND (scraped_at IS NULL OR scraped_at <= ${windowEnd})
			RETURNING id
		`);
		console.info({
			tag: 'TWITTER',
			event: 'twitter_source_processed',
			userName: source.handle,
			since_time: sinceTime,
			until_time: untilTime,
			pages: fetched.pages,
			provider_tweets: fetched.providerTweets,
			normalized_tweets: admission.normalizedTweets,
			admitted_drafts: admission.admittedDrafts,
			skipped_items: fetched.skippedItems + admission.skippedItems,
			created: admission.created,
			deduplicated: admission.deduplicated,
			watermark_advanced: updated.rows.length > 0,
		});
	} catch (error) {
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

export async function handleTwitterCron(env: CoreEnv, windowEnd: Date = new Date()): Promise<void> {
	if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
	if (!Number.isFinite(windowEnd.getTime())) throw new Error('Twitter monitor window end is invalid');
	const db = await connectCoreDb(env);
	console.info({ tag: 'TWITTER', msg: 'start', window_end: windowEnd.toISOString() });
	const { rows: sources } = await db.execute<TwitterSource>(sql`
		SELECT id::text AS id, handle, scraped_at AS "scrapedAt", created_at AS "createdAt"
		FROM sources
		WHERE enabled = true AND monitor_kind = 'twitter'
	`);
	if (!sources.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
		return;
	}

	const groups = Math.ceil(sources.length / TWITTER_SOURCE_CONCURRENCY);
	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', sources: sources.length, groups });
	const systemFailures: unknown[] = [];
	for (let offset = 0; offset < sources.length; offset += TWITTER_SOURCE_CONCURRENCY) {
		const group = sources.slice(offset, offset + TWITTER_SOURCE_CONCURRENCY);
		const results = await Promise.allSettled(group.map((source) => processTwitterSource(env, db, source, windowEnd)));
		for (const result of results) {
			if (result.status === 'rejected') systemFailures.push(result.reason);
		}
	}

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		sources: sources.length,
		groups,
		failed_sources: systemFailures.length,
	});
	if (systemFailures.length) {
		throw new AggregateError(systemFailures, `${systemFailures.length} Twitter monitor operations failed`);
	}
}
