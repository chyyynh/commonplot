import { normalizeUrl } from '@core-shared/url';
import { type CoreDb, connectCoreDb } from '@db/connection';
import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/monitored-source';
import { admitDiscoveredSourceResources, type SourceResourceDraft } from '@ingest/processing-jobs';
import { parseTwitterAdvancedSearchPage, type Tweet } from './twitter-data';

// Twitter Monitor

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

const TWITTER_SOURCE_CONCURRENCY = 5;

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

type TwitterAdmissionCounts = { created: number; deduplicated: number };

function emptyTwitterAdmissionCounts(): TwitterAdmissionCounts {
	return { created: 0, deduplicated: 0 };
}

async function saveTweets(env: CoreEnv, tweets: Tweet[], source: MonitoredSource) {
	const counts = emptyTwitterAdmissionCounts();
	const drafts = new Map<string, SourceResourceDraft>();
	let skippedItems = 0;
	for (const tweet of tweets) {
		try {
			const userName = monitoredAuthorUserName(tweet);
			if (!userName) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no monitored author identity`);
			if (userName !== source.handle) throw new Error(`Tweet ${tweet.id ?? tweet.url} is not attributed to @${source.handle}`);
			const url = normalizeUrl(tweet.url);
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
	if (!pending.length) return { admittedDrafts: 0, counts, skippedItems };
	const outcomes = await admitDiscoveredSourceResources(env, pending);

	for (const [index, outcome] of outcomes.entries()) {
		const draft = pending[index]!;
		counts[outcome]++;
		console.info({
			tag: 'TWITTER',
			event: 'twitter_resource_admitted',
			admission: outcome,
			userName: source.handle,
			url: draft.url,
		});
	}
	return { admittedDrafts: pending.length, counts, skippedItems };
}

type TwitterSourceMetrics = {
	admittedDrafts: number;
	counts: TwitterAdmissionCounts;
	normalizedTweets: number;
	pages: number;
	providerTweets: number;
	skippedItems: number;
	sourceId: string;
};

type TwitterSourceOutcome = TwitterSourceMetrics & ({ status: 'completed' } | { status: 'failed'; error: unknown });

async function processTwitterSource(env: CoreEnv, db: CoreDb, source: MonitoredSource, windowEnd: Date): Promise<TwitterSourceOutcome> {
	let sinceTime: number | null = null;
	let untilTime: number | null = null;
	try {
		sinceTime = Math.floor(new Date(source.scrapedAt ?? source.createdAt).getTime() / 1000);
		untilTime = Math.floor(windowEnd.getTime() / 1000);
		const fetched = await fetchTweetsForSource(env.KAITO_API_KEY, source.handle, sinceTime, untilTime);
		const saved = await saveTweets(env, fetched.tweets, source);
		const outcome: TwitterSourceOutcome = {
			admittedDrafts: saved.admittedDrafts,
			counts: saved.counts,
			normalizedTweets: fetched.tweets.length,
			pages: fetched.pages,
			providerTweets: fetched.providerTweets,
			skippedItems: fetched.skippedItems + saved.skippedItems,
			sourceId: source.id,
			status: 'completed',
		};
		console.info({
			tag: 'TWITTER',
			event: 'twitter_source_processed',
			userName: source.handle,
			since_time: sinceTime,
			until_time: untilTime,
			pages: outcome.pages,
			provider_tweets: outcome.providerTweets,
			normalized_tweets: outcome.normalizedTweets,
			admitted_drafts: outcome.admittedDrafts,
			skipped_items: outcome.skippedItems,
			...outcome.counts,
		});
		return outcome;
	} catch (error) {
		try {
			await recordSourceFailure(db, source.id, error);
		} catch (recordError) {
			console.error({
				tag: 'TWITTER',
				event: 'twitter_source_failure_record_failed',
				userName: source.handle,
				error: recordError instanceof Error ? recordError.message : String(recordError),
			});
		}
		console.error({
			tag: 'TWITTER',
			event: 'twitter_source_failed',
			userName: source.handle,
			...(sinceTime !== null && untilTime !== null ? { since_time: sinceTime, until_time: untilTime } : {}),
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			admittedDrafts: 0,
			counts: emptyTwitterAdmissionCounts(),
			error,
			normalizedTweets: 0,
			pages: 0,
			providerTweets: 0,
			skippedItems: 0,
			sourceId: source.id,
			status: 'failed',
		};
	}
}

type TwitterMonitorOutcome = {
	admittedDrafts: number;
	advancedSources: number;
	counts: TwitterAdmissionCounts;
	incompleteSources: number;
	normalizedTweets: number;
	pages: number;
	providerTweets: number;
	skippedItems: number;
	supersededSources: number;
	systemFailures: unknown[];
};

async function processTwitterSources(
	env: CoreEnv,
	db: CoreDb,
	sources: MonitoredSource[],
	windowEnd: Date,
): Promise<TwitterMonitorOutcome> {
	const outcomes: TwitterSourceOutcome[] = [];
	for (let offset = 0; offset < sources.length; offset += TWITTER_SOURCE_CONCURRENCY) {
		const group = sources.slice(offset, offset + TWITTER_SOURCE_CONCURRENCY);
		outcomes.push(...(await Promise.all(group.map((source) => processTwitterSource(env, db, source, windowEnd)))));
	}

	const completedSourceIds = outcomes.filter((outcome) => outcome.status === 'completed').map((outcome) => outcome.sourceId);
	const failedSources = outcomes.filter(
		(outcome): outcome is TwitterSourceMetrics & { status: 'failed'; error: unknown } => outcome.status === 'failed',
	);
	const systemFailures = failedSources.map((outcome) => outcome.error);
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

	const counts = emptyTwitterAdmissionCounts();
	for (const outcome of outcomes) {
		counts.created += outcome.counts.created;
		counts.deduplicated += outcome.counts.deduplicated;
	}
	return {
		admittedDrafts: outcomes.reduce((total, outcome) => total + outcome.admittedDrafts, 0),
		advancedSources,
		counts,
		incompleteSources: failedSources.length + watermarkFailures,
		normalizedTweets: outcomes.reduce((total, outcome) => total + outcome.normalizedTweets, 0),
		pages: outcomes.reduce((total, outcome) => total + outcome.pages, 0),
		providerTweets: outcomes.reduce((total, outcome) => total + outcome.providerTweets, 0),
		skippedItems: outcomes.reduce((total, outcome) => total + outcome.skippedItems, 0),
		supersededSources: completedSourceIds.length - advancedSources - watermarkFailures,
		systemFailures,
	};
}

export async function handleTwitterCron(env: CoreEnv, windowEnd: Date = new Date()): Promise<void> {
	if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
	if (!Number.isFinite(windowEnd.getTime())) throw new Error('Twitter monitor window end is invalid');
	const db = await connectCoreDb(env);
	console.info({ tag: 'TWITTER', msg: 'start', window_end: windowEnd.toISOString() });
	const sources = await loadMonitoredSources(db, 'twitter');
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
		...outcome.counts,
		advanced_sources: outcome.advancedSources,
		superseded_sources: outcome.supersededSources,
		incomplete_sources: outcome.incompleteSources,
	});
	if (outcome.systemFailures.length) {
		throw new AggregateError(outcome.systemFailures, `${outcome.systemFailures.length} Twitter monitor operations failed`);
	}
}
