import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import { canonicalResourcePlatformUrl, normalizeUrl } from '@core-shared/url';
import type { SourceResourceDraft } from '@ingest/domain/resource-admission-store';
import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/domain/source-store';
import { admitDiscoveredSourceResources } from '@ingest/workflow';
import { buildTweetTitle } from './twitter-acquisition';
import { isTwitterReply, parseTwitterAdvancedSearchPage, type Tweet, twitterSelfReplyRootId } from './twitter-data';

// Twitter Monitor

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

/** Max usernames per query batch to stay within query length limits */
const TWITTER_BATCH_SIZE = 20;
const TWITTER_WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

function normalizeRetweet(tweet: Tweet): Tweet | null {
	if (tweet.retweeted_tweet) {
		const retweeter = tweet.author;
		if (!retweeter?.name.trim() || !retweeter.userName.trim()) {
			throw new Error(`Retweet ${tweet.id ?? tweet.url} has no complete author`);
		}
		const normalized = {
			...tweet.retweeted_tweet,
			retweetedBy: {
				tweetId: tweet.id,
				tweetUrl: tweet.url,
				retweetedAt: tweet.createdAt,
				authorName: retweeter.name,
				authorUserName: retweeter.userName,
				authorProfilePicture: retweeter.profilePicture,
				authorVerified: retweeter.isBlueVerified,
			},
		};
		if (!normalized.author?.name.trim() || !normalized.author.userName.trim()) {
			throw new Error(`Retweeted tweet ${normalized.id ?? normalized.url} has no complete author`);
		}
		return normalized;
	}
	if (tweet.text.startsWith('RT @')) return null;
	if (!tweet.author?.name.trim() || !tweet.author.userName.trim()) {
		throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
	}
	return tweet;
}

/** Oldest effective watermark in one API batch, minus a one-hour overlap. */
function calculateMonitoringSinceTime(users: Array<{ scrapedAt?: Date | string | null; createdAt: Date | string }>): number {
	let oldest = Number.POSITIVE_INFINITY;
	for (const user of users) {
		const watermark = user.scrapedAt === null || user.scrapedAt === undefined ? user.createdAt : user.scrapedAt;
		const timestamp = new Date(watermark).getTime();
		if (!Number.isFinite(timestamp)) throw new Error('Twitter source has an invalid monitoring watermark');
		oldest = Math.min(oldest, timestamp);
	}
	if (!Number.isFinite(oldest)) throw new Error('Cannot calculate a Twitter watermark for an empty batch');
	return Math.floor((oldest - TWITTER_WATERMARK_OVERLAP_MS) / 1000);
}

type TwitterBatchFetch = {
	tweets: Tweet[];
	failedUserNames: Set<string>;
	hasUnattributedFailure: boolean;
};

function normalizeFetchedTweets(tweets: Tweet[], monitoredUserNames: ReadonlySet<string>): TwitterBatchFetch {
	const normalizedTweets: Tweet[] = [];
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	for (const tweet of tweets) {
		try {
			const normalized = normalizeRetweet(tweet);
			if (normalized) normalizedTweets.push(normalized);
		} catch (error) {
			const userName = tweet.author?.userName.trim().toLowerCase();
			if (userName && monitoredUserNames.has(userName)) failedUserNames.add(userName);
			else hasUnattributedFailure = true;
			console.error({
				tag: 'TWITTER',
				msg: 'Tweet normalization failed',
				tweetId: tweet.id,
				userName: userName || undefined,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { tweets: normalizedTweets, failedUserNames, hasUnattributedFailure };
}

/** Fetch all tweets matching `(from:u1 OR from:u2 …) since_time:<unix>`, paginating through cursors. */
async function fetchTweetsForBatch(apiKey: string, userNames: string[], sinceTime: number): Promise<TwitterBatchFetch> {
	const fromClause = userNames.map((u) => `from:${u}`).join(' OR ');
	const query = `(${fromClause}) since_time:${sinceTime}`;
	const monitoredUserNames = new Set(userNames);

	const tweets: Tweet[] = [];
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	let cursor = '';
	const seenCursors = new Set<string>();

	while (true) {
		const params = new URLSearchParams({ query, queryType: 'Latest' });
		if (cursor) params.set('cursor', cursor);

		const response = await fetchWithTimeout(
			`${TWITTER_ADVANCED_SEARCH_API}?${params}`,
			{ headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } },
			20_000,
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Twitter Advanced Search failed with HTTP ${response.status}`);
		}
		const apiRes = parseTwitterAdvancedSearchPage(JSON.parse(await readTextWithLimit(response, 2 * 1024 * 1024)));
		const normalizedPage = normalizeFetchedTweets(apiRes.tweets, monitoredUserNames);
		tweets.push(...normalizedPage.tweets);
		for (const userName of normalizedPage.failedUserNames) failedUserNames.add(userName);
		hasUnattributedFailure ||= normalizedPage.hasUnattributedFailure;

		if (!apiRes.hasNextPage) break;
		const nextCursor = apiRes.nextCursor?.trim();
		if (!nextCursor) throw new Error('Twitter Advanced Search response omitted the next cursor');
		cursor = nextCursor;
		if (seenCursors.has(cursor)) {
			throw new Error(`Twitter Advanced Search returned a repeated cursor: ${cursor.slice(0, 32)}`);
		}
		seenCursors.add(cursor);
		await scheduler.wait(1000);
	}

	return { tweets, failedUserNames, hasUnattributedFailure };
}

function monitoredAuthorUserName(tweet: Tweet): string | null {
	const userName = tweet.retweetedBy?.authorUserName || tweet.author?.userName;
	return userName?.trim().toLowerCase() || null;
}

type TweetSaveResult = {
	processed: number;
	failedUserNames: Set<string>;
	hasUnattributedFailure: boolean;
};

type TwitterResourceDraft = SourceResourceDraft & {
	tweet: Tweet;
	source: MonitoredSource;
};

function latestTwitterDraft(left: TwitterResourceDraft, right: TwitterResourceDraft): TwitterResourceDraft {
	const leftIsReply = isTwitterReply(left.tweet);
	const rightIsReply = isTwitterReply(right.tweet);
	const canonical = leftIsReply && !rightIsReply ? right : left;
	const refresh = [left, right]
		.filter((draft) => draft.refreshRevision)
		.sort((a, b) => twitterDraftTimestamp(b) - twitterDraftTimestamp(a))[0];
	return refresh?.refreshRevision ? { ...canonical, refreshRevision: refresh.refreshRevision } : canonical;
}

function twitterDraftTimestamp(draft: TwitterResourceDraft): number {
	const timestamp = new Date(draft.tweet.createdAt).getTime();
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function twitterSelfReplyRootDraft(tweet: Tweet, source: MonitoredSource): TwitterResourceDraft | null {
	const rootId = twitterSelfReplyRootId(tweet);
	const refreshRevision = tweet.id?.trim();
	const author = tweet.author?.userName.trim();
	if (!rootId || !refreshRevision || !author) return null;
	return {
		tweet,
		source,
		sourceId: source.id,
		url: canonicalResourcePlatformUrl('twitter', rootId),
		title: `Twitter thread by @${author}`,
		publishedDate: null,
		summary: null,
		kind: 'post',
		resourcePlatform: 'twitter',
		originalLang: tweet.lang,
		keywords: [],
		refreshRevision,
	};
}

function twitterResourceDraft(tweet: Tweet, sourcesByUserName: ReadonlyMap<string, MonitoredSource>): TwitterResourceDraft | null {
	const userName = monitoredAuthorUserName(tweet);
	if (!userName) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no monitored author identity`);
	const source = sourcesByUserName.get(userName);
	if (!source) throw new Error(`Tweet ${tweet.id ?? tweet.url} is not attributed to a monitored source`);
	if (isTwitterReply(tweet)) return twitterSelfReplyRootDraft(tweet, source);

	const url = normalizeUrl(tweet.url);
	const publishedDate = new Date(tweet.createdAt);
	if (Number.isNaN(publishedDate.getTime())) throw new Error(`Tweet ${tweet.id ?? url} has invalid publishedDate`);
	return {
		tweet,
		source,
		sourceId: source.id,
		url,
		title: buildTweetTitle(tweet),
		publishedDate,
		summary: null,
		kind: 'post',
		resourcePlatform: 'twitter',
		originalLang: tweet.lang,
		keywords: tweet.hashTags,
	};
}

function twitterResourceDrafts(
	tweets: Tweet[],
	sourcesByUserName: ReadonlyMap<string, MonitoredSource>,
): { drafts: Map<string, TwitterResourceDraft>; failedUserNames: Set<string>; hasUnattributedFailure: boolean } {
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	const drafts = new Map<string, TwitterResourceDraft>();
	for (const tweet of tweets) {
		try {
			const draft = twitterResourceDraft(tweet, sourcesByUserName);
			if (!draft) continue;
			const existing = drafts.get(draft.url);
			drafts.set(draft.url, existing ? latestTwitterDraft(existing, draft) : draft);
		} catch (error) {
			const userName = monitoredAuthorUserName(tweet);
			if (userName && sourcesByUserName.has(userName)) failedUserNames.add(userName);
			else hasUnattributedFailure = true;
			console.error({
				tag: 'TWITTER',
				msg: 'Tweet save failed',
				url: tweet.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { drafts, failedUserNames, hasUnattributedFailure };
}

async function saveTweets(
	env: CoreEnv,
	tweets: Tweet[],
	sourcesByUserName: ReadonlyMap<string, MonitoredSource>,
): Promise<TweetSaveResult> {
	let processed = 0;
	const prepared = twitterResourceDrafts(tweets, sourcesByUserName);
	const { drafts, failedUserNames, hasUnattributedFailure } = prepared;
	const pending = [...drafts.values()];
	if (!pending.length) return { processed, failedUserNames, hasUnattributedFailure };
	const outcomes = await admitDiscoveredSourceResources(env, pending).catch((error) => {
		console.error({
			tag: 'TWITTER',
			msg: 'Twitter resource batch lookup failed',
			error: error instanceof Error ? error.message : String(error),
		});
		for (const draft of pending) {
			failedUserNames.add(draft.source.handle);
		}
		return null;
	});
	if (!outcomes) return { processed, failedUserNames, hasUnattributedFailure };

	for (const [index, outcome] of outcomes.entries()) {
		const draft = pending[index]!;
		if (outcome.status === 'fulfilled') {
			processed++;
			console.info({
				tag: 'TWITTER',
				msg:
					outcome.value === 'created'
						? 'Saved discovered tweet'
						: outcome.value === 'refreshed'
							? 'Refreshing evolved Twitter thread'
							: 'Resource already exists (dedup)',
				author: draft.tweet.author?.userName,
				refreshRevision: draft.refreshRevision,
			});
			continue;
		}
		failedUserNames.add(draft.source.handle);
		console.error({
			tag: 'TWITTER',
			msg: 'Tweet save failed',
			url: draft.url,
			error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
		});
	}
	return { processed, failedUserNames, hasUnattributedFailure };
}

type TwitterBatchOutcome = {
	processed: number;
	advancedSources: number;
	incomplete: boolean;
	systemFailures: unknown[];
};

async function settleTwitterBatch(
	env: CoreEnv,
	batch: MonitoredSource[],
	fetched: TwitterBatchFetch,
	saved: TweetSaveResult,
	runStartedAt: Date,
): Promise<TwitterBatchOutcome> {
	if (fetched.hasUnattributedFailure || saved.hasUnattributedFailure) {
		return { processed: saved.processed, advancedSources: 0, incomplete: true, systemFailures: [] };
	}

	const failedUserNames = new Set([...fetched.failedUserNames, ...saved.failedUserNames]);
	const completedSourceIds: string[] = [];
	for (const source of batch) {
		if (failedUserNames.has(source.handle)) {
			// Per-user failures are attributable (unlike batch-level fetch errors),
			// so they feed the same pending-validation lifecycle as RSS/YouTube.
			await recordSourceFailure(env, source.id, new Error(`Twitter fetch/persist failed for @${source.handle}`));
		} else {
			completedSourceIds.push(source.id);
		}
	}
	const incomplete = failedUserNames.size > 0;
	if (!completedSourceIds.length) {
		return { processed: saved.processed, advancedSources: 0, incomplete, systemFailures: [] };
	}

	try {
		await markSourcesScraped(env, completedSourceIds, runStartedAt);
		return {
			processed: saved.processed,
			advancedSources: completedSourceIds.length,
			incomplete,
			systemFailures: [],
		};
	} catch (error) {
		console.error({
			tag: 'TWITTER',
			msg: 'Twitter source watermark update failed',
			userNames: batch.map((source) => source.handle),
			error: error instanceof Error ? error.message : String(error),
		});
		return { processed: saved.processed, advancedSources: 0, incomplete: true, systemFailures: [error] };
	}
}

async function processTwitterBatches(
	env: CoreEnv,
	sources: MonitoredSource[],
	runStartedAt: Date,
): Promise<{ processed: number; advancedSources: number; incompleteBatches: number; systemFailures: unknown[] }> {
	let processed = 0;
	let advancedSources = 0;
	let incompleteBatches = 0;
	const systemFailures: unknown[] = [];
	for (let offset = 0; offset < sources.length; offset += TWITTER_BATCH_SIZE) {
		const batch = sources.slice(offset, offset + TWITTER_BATCH_SIZE);
		const userNames = batch.map((source) => source.handle);
		let fetched: TwitterBatchFetch;
		try {
			const sinceTime = calculateMonitoringSinceTime(batch);
			fetched = await fetchTweetsForBatch(env.KAITO_API_KEY, userNames, sinceTime);
		} catch (error) {
			incompleteBatches++;
			systemFailures.push(error);
			console.error({
				tag: 'TWITTER',
				msg: 'Twitter batch fetch failed',
				userNames,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		const sourcesByUserName = new Map(batch.map((source) => [source.handle, source]));
		const saved = await saveTweets(env, fetched.tweets, sourcesByUserName);
		const outcome = await settleTwitterBatch(env, batch, fetched, saved, runStartedAt);
		processed += outcome.processed;
		advancedSources += outcome.advancedSources;
		if (outcome.incomplete) incompleteBatches++;
		systemFailures.push(...outcome.systemFailures);
	}
	return { processed, advancedSources, incompleteBatches, systemFailures };
}

export async function handleTwitterCron(env: CoreEnv): Promise<void> {
	if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
	console.info({ tag: 'TWITTER', msg: 'start' });
	const runStartedAt = new Date();
	const users = await loadMonitoredSources(env, 'twitter');
	if (!users.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
		return;
	}

	const batches = Math.ceil(users.length / TWITTER_BATCH_SIZE);

	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', users: users.length, batches });

	const { processed, advancedSources, incompleteBatches, systemFailures } = await processTwitterBatches(env, users, runStartedAt);

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		processed,
		users: users.length,
		advancedSources,
		incompleteBatches,
		batches,
	});
	if (systemFailures.length) {
		throw new AggregateError(systemFailures, `${systemFailures.length} Twitter monitor batches failed`);
	}
}
