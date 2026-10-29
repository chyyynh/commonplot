import { z } from 'zod';
import type { MonitorAdapter } from '.';
import { fetchTwitterApi } from '../adapters/twitter';
import type { SourceResourceDraft } from '../contracts/processing-target';

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

/**
 * Each window starts this long before the last one ended: search indexes a tweet a while after it is posted, so one
 * posted just before a window closed can be missing from it. Admission drops the tweets seen twice.
 */
const WINDOW_OVERLAP_SECONDS = 30 * 60;

/** Fetch one fixed monitoring window using twitterapi.io's native cursor. */
async function fetchTweets(apiKey: string, userName: string, sinceTime: number, untilTime: number) {
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

/** The account's own tweets and retweets as drafts; a tweet attributed to anyone else is skipped. */
function tweetDrafts(tweets: Iterable<DiscoveredTweet>, handle: string) {
	const drafts: SourceResourceDraft[] = [];
	let skipped = 0;
	const skip = (tweetId: string, error: string) => {
		skipped++;
		console.error({ tag: 'TWITTER', event: 'twitter_item_skipped', userName: handle, tweetId, error });
	};
	for (const carrier of tweets) {
		const tweet = carrier.retweeted_tweet ?? carrier;
		const attributedAuthor = carrier.retweeted_tweet
			? carrier.author?.userName
			: carrier.retweetedBy?.authorUserName || carrier.author?.userName;
		const userName = attributedAuthor?.trim().toLowerCase() || null;
		if (userName !== handle) {
			skip(tweet.id, `Tweet ${tweet.id} was attributed to @${userName ?? 'unknown'}, expected @${handle}`);
			continue;
		}
		const publishedDate = new Date(tweet.createdAt);
		if (Number.isNaN(publishedDate.getTime())) {
			skip(tweet.id, `Tweet ${tweet.id} has invalid publishedDate`);
			continue;
		}
		drafts.push({
			url: `https://x.com/i/status/${tweet.id}`,
			sourceHints: { publishedDate: publishedDate.toISOString() },
		});
	}
	return { drafts, skipped };
}

/** An X account, located by its lowercase handle. Each check searches the window since the last one ended. */
const TwitterStateSchema = z.object({ windowEnd: z.iso.datetime({ offset: true }).optional() });

export const twitterMonitor: MonitorAdapter<z.infer<typeof TwitterStateSchema>> = {
	stateSchema: TwitterStateSchema,
	// Every search is billed, so even the busiest account is checked a few times a day.
	interval: { min: 6 * 60 * 60, max: 24 * 60 * 60 },
	concurrency: 3,
	async poll(env, monitor) {
		if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
		const windowEnd = new Date();
		const sinceTime = monitor.state.windowEnd
			? Math.floor(new Date(monitor.state.windowEnd).getTime() / 1000) - WINDOW_OVERLAP_SECONDS
			: Math.floor(new Date(monitor.createdAt).getTime() / 1000);
		const untilTime = Math.floor(windowEnd.getTime() / 1000);
		const fetched = await fetchTweets(env.KAITO_API_KEY, monitor.locator, sinceTime, untilTime);
		const { drafts, skipped } = tweetDrafts(fetched.tweets, monitor.locator);
		return {
			drafts,
			skipped: fetched.skippedItems + skipped,
			state: { windowEnd: windowEnd.toISOString() },
			details: { since_time: sinceTime, until_time: untilTime, pages: fetched.pages, provider_tweets: fetched.providerTweets },
		};
	},
};
