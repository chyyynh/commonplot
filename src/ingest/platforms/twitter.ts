import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import { normalizeUrl, parseTwitterUsername } from '@core-shared/url';
import { withCoreDb } from '@db/client';
import { attachSourceToResources, getExistingResourcesByUrl } from '@ingest/domain/resource-admission-store';
import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/domain/source-store';
import { admitPendingSourceResource, enqueueProcessing } from '@ingest/workflow';
import { buildTweetTitle, type Tweet } from './twitter-acquisition';

async function enqueueTwitterResource(
	env: CoreEnv,
	data: {
		sourceId: string;
		url: string;
		title: string;
		publishedDate: Date;
		originalLang?: string;
		hashTags?: string[];
	},
): Promise<void> {
	await admitPendingSourceResource(env, {
		sourceId: data.sourceId,
		url: data.url,
		title: data.title,
		publishedDate: data.publishedDate,
		summary: null,
		kind: 'post',
		resourcePlatform: 'twitter',
		originalLang: data.originalLang,
		keywords: data.hashTags,
	});
}

function requiredTweetDate(value: string, tweetId: string): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Tweet ${tweetId} has invalid publishedDate`);
	return date;
}

async function saveDiscoveredTweet(tweet: Tweet, env: CoreEnv, monitoredSource: MonitoredSource): Promise<void> {
	const url = normalizeUrl(tweet.url);
	const [existing] = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, [url]));
	if (existing) {
		await withCoreDb(env, (db) => attachSourceToResources(db, [existing.id], monitoredSource.id));
		if (existing.shouldRetryEnrichment) await enqueueProcessing(env, existing.id);
		console.info({
			tag: 'TWITTER',
			msg: 'Resource already exists (dedup)',
			author: tweet.author?.userName,
		});
		return;
	}

	await enqueueTwitterResource(env, {
		sourceId: monitoredSource.id,
		url,
		title: buildTweetTitle(tweet),
		publishedDate: requiredTweetDate(tweet.createdAt, tweet.id ?? url),
		originalLang: tweet.lang,
		hashTags: tweet.hashTags,
	});
	console.info({ tag: 'TWITTER', msg: 'Saved discovered tweet', author: tweet.author?.userName });
}

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
		const apiRes = JSON.parse(await readTextWithLimit(response, 2 * 1024 * 1024)) as {
			tweets?: Tweet[];
			has_next_page?: boolean;
			next_cursor?: string;
		};
		if (!Array.isArray(apiRes.tweets)) throw new Error('Twitter Advanced Search response omitted tweets');
		const normalizedPage = normalizeFetchedTweets(apiRes.tweets, monitoredUserNames);
		tweets.push(...normalizedPage.tweets);
		for (const userName of normalizedPage.failedUserNames) failedUserNames.add(userName);
		hasUnattributedFailure ||= normalizedPage.hasUnattributedFailure;

		if (typeof apiRes.has_next_page !== 'boolean') throw new Error('Twitter Advanced Search response omitted has_next_page');
		if (!apiRes.has_next_page) break;
		const nextCursor = apiRes.next_cursor?.trim();
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

type MonitoredTwitterUser = MonitoredSource & { twitterUserName: string };

type MonitoredTwitterIdentity = {
	twitterUserName: string;
	sources: MonitoredTwitterUser[];
};

function monitoredTwitterUsers(users: MonitoredSource[]): MonitoredTwitterUser[] {
	return users.flatMap((user) => {
		const twitterUserName = parseTwitterUsername(user.handle);
		return twitterUserName ? [{ ...user, twitterUserName: twitterUserName.toLowerCase() }] : [];
	});
}

function monitoredTwitterIdentities(users: MonitoredTwitterUser[]): MonitoredTwitterIdentity[] {
	const byUserName = new Map<string, MonitoredTwitterUser[]>();
	for (const user of users) {
		const sources = byUserName.get(user.twitterUserName) ?? [];
		sources.push(user);
		byUserName.set(user.twitterUserName, sources);
	}
	return [...byUserName].map(([twitterUserName, sources]) => ({ twitterUserName, sources }));
}

function batchTwitterIdentities(identities: MonitoredTwitterIdentity[]): MonitoredTwitterIdentity[][] {
	const batches: MonitoredTwitterIdentity[][] = [];
	for (let i = 0; i < identities.length; i += TWITTER_BATCH_SIZE) {
		batches.push(identities.slice(i, i + TWITTER_BATCH_SIZE));
	}
	return batches;
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

function requiredMonitoredTwitterSource(tweet: Tweet, identities: MonitoredTwitterIdentity[]): MonitoredSource {
	const userName = monitoredAuthorUserName(tweet);
	if (!userName) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no monitored author identity`);
	const identity = identities.find((candidate) => candidate.twitterUserName === userName);
	if (!identity) throw new Error(`Tweet ${tweet.id ?? tweet.url} is not attributed to a monitored source`);
	if (identity.sources.length !== 1) {
		throw new Error(`Twitter identity @${userName} maps to ${identity.sources.length} Source rows`);
	}
	return identity.sources[0]!;
}

async function saveTweets(env: CoreEnv, tweets: Tweet[], identities: MonitoredTwitterIdentity[]): Promise<TweetSaveResult> {
	let processed = 0;
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	for (const tweet of tweets) {
		// Acquisition of a root loads its complete same-author thread context.
		// Replies are not independent Resources and must not become orphan rows
		// merely because the root fell outside this monitor window.
		if (tweet.isReply) continue;
		try {
			const monitoredSource = requiredMonitoredTwitterSource(tweet, identities);
			await saveDiscoveredTweet(tweet, env, monitoredSource);
			processed++;
		} catch (error) {
			const userName = monitoredAuthorUserName(tweet);
			if (userName) failedUserNames.add(userName);
			else hasUnattributedFailure = true;
			console.error({
				tag: 'TWITTER',
				msg: 'Tweet save failed',
				url: tweet.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { processed, failedUserNames, hasUnattributedFailure };
}

// Per-user failures are attributable (unlike batch-level fetch errors), so
// they feed the same pending-validation lifecycle as RSS/YouTube.
async function settleFailedTwitterSources(env: CoreEnv, batch: MonitoredTwitterIdentity[], failedUserNames: Set<string>): Promise<void> {
	for (const identity of batch) {
		if (!failedUserNames.has(identity.twitterUserName)) continue;
		for (const source of identity.sources) {
			await recordSourceFailure(env, source.id, new Error(`Twitter fetch/persist failed for @${identity.twitterUserName}`));
		}
	}
}

type TwitterBatchOutcome = {
	processed: number;
	advancedSources: number;
	incomplete: boolean;
	systemFailures: unknown[];
};

async function settleTwitterBatch(
	env: CoreEnv,
	batch: MonitoredTwitterIdentity[],
	fetched: TwitterBatchFetch,
	saved: TweetSaveResult,
	runStartedAt: Date,
	userNames: string[],
): Promise<TwitterBatchOutcome> {
	if (fetched.hasUnattributedFailure || saved.hasUnattributedFailure) {
		return { processed: saved.processed, advancedSources: 0, incomplete: true, systemFailures: [] };
	}

	const failedUserNames = new Set([...fetched.failedUserNames, ...saved.failedUserNames]);
	await settleFailedTwitterSources(env, batch, failedUserNames);
	const completedSourceIds = batch
		.filter((identity) => !failedUserNames.has(identity.twitterUserName))
		.flatMap((identity) => identity.sources.map((source) => source.id));
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
			userNames,
			error: error instanceof Error ? error.message : String(error),
		});
		return { processed: saved.processed, advancedSources: 0, incomplete: true, systemFailures: [error] };
	}
}

async function processTwitterBatches(
	env: CoreEnv,
	batches: MonitoredTwitterIdentity[][],
	runStartedAt: Date,
): Promise<{ processed: number; advancedSources: number; incompleteBatches: number; systemFailures: unknown[] }> {
	let processed = 0;
	let advancedSources = 0;
	let incompleteBatches = 0;
	const systemFailures: unknown[] = [];
	for (const batch of batches) {
		const userNames = batch.map((identity) => identity.twitterUserName);
		const batchSources = batch.flatMap((identity) => identity.sources);
		let fetched: TwitterBatchFetch;
		try {
			const sinceTime = calculateMonitoringSinceTime(batchSources);
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

		const saved = await saveTweets(env, fetched.tweets, batch);
		const outcome = await settleTwitterBatch(env, batch, fetched, saved, runStartedAt, userNames);
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
	const users = await loadMonitoredSources(env, 'platform');
	if (!users.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
		return;
	}

	const monitoredUsers = monitoredTwitterUsers(users);
	const validSourceIds = new Set(monitoredUsers.map((source) => source.id));
	const invalidSources = users.filter((source) => !validSourceIds.has(source.id));
	for (const source of invalidSources) {
		await recordSourceFailure(env, source.id, new Error('Twitter source has an invalid handle'));
	}
	const identities = monitoredTwitterIdentities(monitoredUsers);
	if (identities.length === 0) {
		console.warn({ tag: 'TWITTER', msg: 'No valid Twitter sources configured', invalidSources: invalidSources.length });
		return;
	}
	const batches = batchTwitterIdentities(identities);

	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', users: identities.length, batches: batches.length });

	const { processed, advancedSources, incompleteBatches, systemFailures } = await processTwitterBatches(env, batches, runStartedAt);

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		processed,
		users: users.length,
		validUsers: monitoredUsers.length,
		advancedSources,
		incompleteBatches,
		batches: batches.length,
	});
	if (systemFailures.length) {
		throw new AggregateError(systemFailures, `${systemFailures.length} Twitter monitor batches failed`);
	}
}
