import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pLimit from 'p-limit';
import { z } from 'zod';
import { fetchTwitterApi } from '../adapters/twitter';
import type { SourceResourceDraft } from '../contracts/processing-target';
import { errorMessage } from '../services/response';
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
});

const TWITTER_SOURCE_CONCURRENCY = 5;
/**
 * Each window starts this long before the last one ended: search indexes a tweet a while after it is posted, so one
 * posted just before a window closed can be missing from it. Admission drops the tweets seen twice.
 */
const WINDOW_OVERLAP_SECONDS = 30 * 60;

/** Fetch one fixed monitoring window using twitterapi.io's native cursor. */
async function fetchTweetsForSource(apiKey: string, userName: string, sinceTime: number, untilTime: number) {
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
		const apiRes = await fetchTwitterApi(
			`tweet/advanced_search?${params}`,
			apiKey,
			'Twitter Advanced Search',
			TwitterAdvancedSearchEnvelopeSchema,
		);
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
	return { tweets: terminalTweets.values(), providerTweets, pages, skippedItems };
}

async function enqueueTweets(db: NodePgDatabase, tweets: Iterable<DiscoveredTweet>, source: TwitterSource) {
	const drafts: SourceResourceDraft[] = [];
	let skippedItems = 0;
	const skip = (tweetId: string, error: string) => {
		skippedItems++;
		console.error({ tag: 'TWITTER', event: 'twitter_item_skipped', userName: source.handle, tweetId, error });
	};
	for (const carrier of tweets) {
		const tweet = carrier.retweeted_tweet ?? carrier;
		const attributedAuthor = carrier.retweeted_tweet
			? carrier.author?.userName
			: carrier.retweetedBy?.authorUserName || carrier.author?.userName;
		const userName = attributedAuthor?.trim().toLowerCase() || null;
		if (userName !== source.handle) {
			skip(tweet.id, `Tweet ${tweet.id} was attributed to @${userName ?? 'unknown'}, expected @${source.handle}`);
			continue;
		}
		const publishedDate = new Date(tweet.createdAt);
		if (Number.isNaN(publishedDate.getTime())) {
			skip(tweet.id, `Tweet ${tweet.id} has invalid publishedDate`);
			continue;
		}
		drafts.push({
			url: `https://x.com/i/status/${tweet.id}`,
			sourceHints: { publishedDate: publishedDate.toISOString(), originalLang: tweet.lang },
		});
	}
	const admission = await enqueueSourceDrafts(db, source.id, drafts);
	return {
		created: admission.created,
		deduplicated: admission.deduplicated,
		skippedItems: skippedItems + admission.skipped,
	};
}

async function processTwitterSource(env: CoreEnv, db: NodePgDatabase, source: TwitterSource, windowEnd: Date) {
	const sinceTime = source.scrapedAt
		? Math.floor(new Date(source.scrapedAt).getTime() / 1000) - WINDOW_OVERLAP_SECONDS
		: Math.floor(new Date(source.createdAt).getTime() / 1000);
	const untilTime = Math.floor(windowEnd.getTime() / 1000);
	try {
		const fetched = await fetchTweetsForSource(env.KAITO_API_KEY, source.handle, sinceTime, untilTime);
		const admission = await enqueueTweets(db, fetched.tweets, source);
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
			error: errorMessage(error),
		});
		throw error;
	}
}

export async function handleTwitterCron(env: CoreEnv, windowEnd: Date): Promise<void> {
	if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
	console.info({ tag: 'TWITTER', msg: 'start', window_end: windowEnd.toISOString() });
	await withCoreDb(env, async (db) => {
		const sources = await listTwitterSources(db);
		if (!sources.length) {
			console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
			return;
		}

		console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', sources: sources.length });
		const limit = pLimit(TWITTER_SOURCE_CONCURRENCY);
		const results = await Promise.allSettled(sources.map((source) => limit(() => processTwitterSource(env, db, source, windowEnd))));
		const systemFailures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));

		console.info({
			tag: 'TWITTER',
			msg: 'end',
			sources: sources.length,
			failed_sources: systemFailures.length,
		});
		if (systemFailures.length) {
			throw new AggregateError(systemFailures, `${systemFailures.length} Twitter monitor operations failed`);
		}
	});
}
