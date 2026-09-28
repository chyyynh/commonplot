import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { SourceResourceDraft } from '../contracts/processing-target';
import { withCoreDb } from '../store/db';
import { advanceSourceWatermark, listTwitterSources, type TwitterSource } from '../store/sources';
import { enqueueSourceDrafts } from './source-drafts';

const DiscoveredTweetIdentitySchema = z.object({
	id: z.string().trim().regex(/^\d+$/),
	createdAt: z.string().min(1),
	lang: z.string().max(35).optional().catch(undefined),
});
const DiscoveredTweetSchema = DiscoveredTweetIdentitySchema.extend({
	author: z.object({ userName: z.string() }).optional(),
	retweetedBy: z.object({ authorUserName: z.string() }).optional(),
	retweeted_tweet: DiscoveredTweetIdentitySchema.nullish().catch(null),
});
type DiscoveredTweet = z.infer<typeof DiscoveredTweetSchema>;

const TwitterAdvancedSearchEnvelopeSchema = z.object({
	tweets: z.array(z.unknown()),
	has_next_page: z.boolean(),
	next_cursor: z.string().nullish(),
	status: z.string().optional(),
	message: z.string().optional(),
	msg: z.string().optional(),
});

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

const TWITTER_SOURCE_CONCURRENCY = 5;

/** Fetch one fixed monitoring window using twitterapi.io's native cursor. */
async function fetchTweetsForSource(apiKey: string, userName: string, sinceTime: number, untilTime: number) {
	if (!/^[a-z0-9_]{1,15}$/.test(userName)) throw new Error('Twitter source has an invalid handle');
	if (!Number.isSafeInteger(sinceTime) || !Number.isSafeInteger(untilTime) || sinceTime < 0 || sinceTime >= untilTime) {
		throw new Error('Twitter monitor has an invalid time window');
	}
	const query = `from:${userName} include:nativeretweets -filter:replies since_time:${sinceTime} until_time:${untilTime}`;
	const terminalTweets = new Map<string, DiscoveredTweet>();
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
		const apiRes = TwitterAdvancedSearchEnvelopeSchema.parse(await response.json());
		if (apiRes.status?.toLowerCase() === 'error') {
			throw new Error(`Twitter Advanced Search failed: ${(apiRes.message ?? apiRes.msg)?.trim() || 'unknown provider error'}`);
		}
		pages++;
		providerTweets += apiRes.tweets.length;
		for (const [index, item] of apiRes.tweets.entries()) {
			const parsed = DiscoveredTweetSchema.safeParse(item);
			if (parsed.success) {
				terminalTweets.set(parsed.data.id, parsed.data);
				continue;
			}
			skippedItems++;
			const issue = parsed.error.issues[0];
			console.error({
				tag: 'TWITTER',
				event: 'twitter_provider_item_skipped',
				userName,
				page: pages,
				item_index: index,
				error: issue ? `${issue.path.join('.') || 'tweet'}: ${issue.message}` : 'Tweet is invalid',
			});
		}
		if (!apiRes.has_next_page) break;
		const nextCursor = apiRes.next_cursor?.trim();
		if (!nextCursor) throw new Error(`Twitter Advanced Search omitted the next cursor for @${userName}`);
		if (seenCursors.has(nextCursor)) throw new Error(`Twitter Advanced Search repeated its cursor for @${userName}`);
		seenCursors.add(nextCursor);
		cursor = nextCursor;
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

async function enqueueTweets(env: CoreEnv, db: NodePgDatabase, tweets: Iterable<DiscoveredTweet>, source: TwitterSource) {
	const drafts: SourceResourceDraft[] = [];
	let skippedItems = 0;
	for (const carrier of tweets) {
		const tweet = carrier.retweeted_tweet ?? carrier;
		try {
			const attributedAuthor = carrier.retweeted_tweet
				? carrier.author?.userName
				: carrier.retweetedBy?.authorUserName || carrier.author?.userName;
			const userName = attributedAuthor?.trim().toLowerCase() || null;
			if (userName !== source.handle) {
				throw new Error(`Tweet ${tweet.id} was attributed to @${userName ?? 'unknown'}, expected @${source.handle}`);
			}
			const url = `https://x.com/i/status/${tweet.id}`;
			const publishedDate = new Date(tweet.createdAt);
			if (Number.isNaN(publishedDate.getTime())) throw new Error(`Tweet ${tweet.id} has invalid publishedDate`);
			drafts.push({
				url,
				sourceHints: { publishedDate: publishedDate.toISOString(), originalLang: tweet.lang },
			});
		} catch (error) {
			skippedItems++;
			console.error({
				tag: 'TWITTER',
				event: 'twitter_item_skipped',
				userName: source.handle,
				tweetId: tweet.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const admission = await enqueueSourceDrafts(env, db, source.id, drafts);
	return {
		created: admission.created,
		deduplicated: admission.deduplicated,
		skippedItems: skippedItems + admission.skipped,
	};
}

async function processTwitterSource(env: CoreEnv, db: NodePgDatabase, source: TwitterSource, windowEnd: Date) {
	const sinceTime = Math.floor(new Date(source.scrapedAt ?? source.createdAt).getTime() / 1000);
	const untilTime = Math.floor(windowEnd.getTime() / 1000);
	try {
		const fetched = await fetchTweetsForSource(env.KAITO_API_KEY, source.handle, sinceTime, untilTime);
		const admission = await enqueueTweets(env, db, fetched.tweets, source);
		const watermarkAdvanced = await advanceSourceWatermark(db, source.id, windowEnd);
		console.info({
			tag: 'TWITTER',
			event: 'twitter_source_processed',
			userName: source.handle,
			since_time: sinceTime,
			until_time: untilTime,
			pages: fetched.pages,
			provider_tweets: fetched.providerTweets,
			skipped_items: fetched.skippedItems + admission.skippedItems,
			created: admission.created,
			deduplicated: admission.deduplicated,
			watermark_advanced: watermarkAdvanced,
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
	console.info({ tag: 'TWITTER', msg: 'start', window_end: windowEnd.toISOString() });
	await withCoreDb(env, (db) => monitorTwitterSources(env, db, windowEnd));
}

async function monitorTwitterSources(env: CoreEnv, db: NodePgDatabase, windowEnd: Date): Promise<void> {
	const sources = await listTwitterSources(db);
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
