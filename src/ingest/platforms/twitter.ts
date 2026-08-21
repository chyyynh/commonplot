import { readTextWithLimit } from '@core-shared/http';
import { canonicalResourcePlatformUrl, normalizeUrl } from '@core-shared/url';
import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/domain/source-store';
import { admitDiscoveredSourceResources, type SourceResourceDraft } from '@ingest/resource-admission';
import {
	buildTwitterMonitorSearchQueries,
	isTwitterReply,
	nextTwitterSearchWindow,
	parseTwitterAdvancedSearchPage,
	type Tweet,
	type TwitterMonitorSearch,
	type TwitterSearchWindow,
	twitterSearchNeedsOlderWindow,
	twitterSearchWindow,
	twitterSelfReplyRootId,
	withTwitterSearchWindow,
} from './twitter-data';
import { fetchTwitterProvider } from './twitter-provider';

// Twitter Monitor

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

const TWITTER_SOURCE_CONCURRENCY = 5;
const TWITTER_WATERMARK_OVERLAP_MS = 60 * 60 * 1000;
const TWITTER_SEARCH_MAX_REQUESTS = 256;

function monitoredAuthorUserName(tweet: Tweet): string | null {
	const userName = tweet.retweetedBy?.authorUserName || tweet.author?.userName;
	return userName?.trim().toLowerCase() || null;
}

function normalizeRetweet(tweet: Tweet): Tweet | null {
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
	if (tweet.text.startsWith('RT @')) return null;
	if (!tweet.author?.name.trim() || !tweet.author.userName.trim()) {
		throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
	}
	return tweet;
}

type TwitterSourceFetch = {
	tweets: Tweet[];
	providerTweets: number;
	pages: number;
	searches: number;
	errors: unknown[];
};

function normalizeFetchedTweets(tweets: Tweet[], monitoredUserName: string): Pick<TwitterSourceFetch, 'errors' | 'tweets'> {
	const normalizedTweets: Tweet[] = [];
	const errors: unknown[] = [];
	for (const tweet of tweets) {
		try {
			const normalized = normalizeRetweet(tweet);
			if (!normalized) continue;
			const attributedUserName = monitoredAuthorUserName(normalized);
			if (attributedUserName !== monitoredUserName) {
				throw new Error(
					`Tweet ${normalized.id ?? normalized.url} was attributed to @${attributedUserName ?? 'unknown'}, expected @${monitoredUserName}`,
				);
			}
			normalizedTweets.push(normalized);
		} catch (error) {
			errors.push(error);
			console.error({
				tag: 'TWITTER',
				msg: 'Tweet normalization failed',
				tweetId: tweet.id,
				userName: monitoredUserName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { tweets: normalizedTweets, errors };
}

/** Fetch one filtered search stream through complete, cursor-free time slices. */
async function fetchTweetsForSearch(
	apiKey: string,
	userName: string,
	search: TwitterMonitorSearch,
	window: TwitterSearchWindow,
): Promise<Omit<TwitterSourceFetch, 'searches'>> {
	const terminalTweets = new Map<string, Tweet>();
	let providerTweets = 0;
	let pages = 0;
	let currentWindow = window;

	while (true) {
		if (pages >= TWITTER_SEARCH_MAX_REQUESTS) {
			throw new Error(`Twitter Advanced Search exceeded ${TWITTER_SEARCH_MAX_REQUESTS} time-slice requests`);
		}
		const params = new URLSearchParams({ query: withTwitterSearchWindow(search.query, currentWindow), queryType: 'Latest' });

		const response = await fetchTwitterProvider(`${TWITTER_ADVANCED_SEARCH_API}?${params}`, apiKey, {
			operation: 'advanced-search',
			searchKind: search.kind,
			sourceHandle: userName,
			timeoutMs: 20_000,
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Twitter Advanced Search failed with HTTP ${response.status}`);
		}
		const apiRes = parseTwitterAdvancedSearchPage(JSON.parse(await readTextWithLimit(response, 2 * 1024 * 1024)));
		pages++;
		providerTweets += apiRes.tweets.length;
		for (const tweet of apiRes.tweets) terminalTweets.set(tweet.id?.trim() || tweet.url, tweet);
		if (!twitterSearchNeedsOlderWindow(apiRes)) break;
		currentWindow = nextTwitterSearchWindow(currentWindow, apiRes.tweets, `Twitter monitor search for @${userName}`);
		await scheduler.wait(250);
	}
	const normalized = normalizeFetchedTweets([...terminalTweets.values()], userName);

	console.info({
		tag: 'TWITTER',
		event: 'twitter_search_stream_completed',
		userName,
		search_kind: search.kind,
		pages,
		provider_tweets: providerTweets,
		normalized_tweets: normalized.tweets.length,
		errors: normalized.errors.length,
	});
	return { tweets: normalized.tweets, providerTweets, pages, errors: normalized.errors };
}

/** Fetch only authored posts and authored self-replies; discard duplicate results across the two streams. */
async function fetchTweetsForSource(apiKey: string, userName: string, window: TwitterSearchWindow): Promise<TwitterSourceFetch> {
	const searches = buildTwitterMonitorSearchQueries(userName);
	const results = await Promise.all(searches.map((search) => fetchTweetsForSearch(apiKey, userName, search, window)));
	const tweets = new Map<string, Tweet>();
	for (const result of results) {
		for (const tweet of result.tweets) tweets.set(tweet.id?.trim() || tweet.url, tweet);
	}
	return {
		tweets: [...tweets.values()],
		providerTweets: results.reduce((total, result) => total + result.providerTweets, 0),
		pages: results.reduce((total, result) => total + result.pages, 0),
		searches: searches.length,
		errors: results.flatMap((result) => result.errors),
	};
}

const TWITTER_ADMISSION_STATUSES = ['created', 'existing', 'refreshed'] as const;
type TwitterAdmissionStatus = (typeof TWITTER_ADMISSION_STATUSES)[number];

type TwitterAdmissionCounts = Record<TwitterAdmissionStatus, number>;

type TweetSaveResult = {
	admittedDrafts: number;
	counts: TwitterAdmissionCounts;
	errors: unknown[];
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
	if (!rootId || !refreshRevision) return null;
	return {
		tweet,
		source,
		sourceId: source.id,
		url: canonicalResourcePlatformUrl('twitter', rootId),
		publishedDate: null,
		summary: null,
		originalLang: tweet.lang,
		keywords: [],
		refreshRevision,
	};
}

function twitterResourceDraft(tweet: Tweet, source: MonitoredSource): TwitterResourceDraft | null {
	const userName = monitoredAuthorUserName(tweet);
	if (!userName) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no monitored author identity`);
	if (userName !== source.handle) throw new Error(`Tweet ${tweet.id ?? tweet.url} is not attributed to @${source.handle}`);
	if (isTwitterReply(tweet)) return twitterSelfReplyRootDraft(tweet, source);

	const url = normalizeUrl(tweet.url);
	const publishedDate = new Date(tweet.createdAt);
	if (Number.isNaN(publishedDate.getTime())) throw new Error(`Tweet ${tweet.id ?? url} has invalid publishedDate`);
	return {
		tweet,
		source,
		sourceId: source.id,
		url,
		publishedDate,
		summary: null,
		originalLang: tweet.lang,
		keywords: tweet.hashTags,
	};
}

function twitterResourceDrafts(tweets: Tweet[], source: MonitoredSource): { drafts: Map<string, TwitterResourceDraft>; errors: unknown[] } {
	const errors: unknown[] = [];
	const drafts = new Map<string, TwitterResourceDraft>();
	for (const tweet of tweets) {
		try {
			const draft = twitterResourceDraft(tweet, source);
			if (!draft) continue;
			const existing = drafts.get(draft.url);
			drafts.set(draft.url, existing ? latestTwitterDraft(existing, draft) : draft);
		} catch (error) {
			errors.push(error);
			console.error({
				tag: 'TWITTER',
				msg: 'Tweet save failed',
				userName: source.handle,
				url: tweet.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { drafts, errors };
}

function emptyTwitterAdmissionCounts(): TwitterAdmissionCounts {
	return { created: 0, existing: 0, refreshed: 0 };
}

async function saveTweets(env: CoreEnv, tweets: Tweet[], source: MonitoredSource): Promise<TweetSaveResult> {
	const counts = emptyTwitterAdmissionCounts();
	const prepared = twitterResourceDrafts(tweets, source);
	const { drafts, errors } = prepared;
	const pending = [...drafts.values()];
	if (!pending.length) return { admittedDrafts: 0, counts, errors };
	const outcomes = await admitDiscoveredSourceResources(env, pending).catch((error) => {
		console.error({
			tag: 'TWITTER',
			msg: 'Twitter resource lookup failed',
			userName: source.handle,
			error: error instanceof Error ? error.message : String(error),
		});
		errors.push(error);
		return null;
	});
	if (!outcomes) return { admittedDrafts: pending.length, counts, errors };

	for (const [index, outcome] of outcomes.entries()) {
		const draft = pending[index]!;
		if (outcome.status === 'fulfilled') {
			counts[outcome.value]++;
			console.info({
				tag: 'TWITTER',
				event: 'twitter_resource_admitted',
				admission: outcome.value,
				userName: source.handle,
				url: draft.url,
				refreshRevision: draft.refreshRevision,
			});
			continue;
		}
		errors.push(outcome.reason);
		console.error({
			tag: 'TWITTER',
			msg: 'Tweet save failed',
			userName: source.handle,
			url: draft.url,
			error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
		});
	}
	return { admittedDrafts: pending.length, counts, errors };
}

type TwitterSourceOutcome = {
	admittedDrafts: number;
	complete: boolean;
	counts: TwitterAdmissionCounts;
	errors: unknown[];
	normalizedTweets: number;
	pages: number;
	providerTweets: number;
	searches: number;
	sourceId: string;
};

function twitterSourceFailure(userName: string, errors: unknown[]): Error {
	const first = errors[0];
	const message = first instanceof Error ? first.message : String(first);
	return new Error(`${errors.length} Twitter monitor operation(s) failed for @${userName}: ${message}`);
}

async function processTwitterSource(env: CoreEnv, source: MonitoredSource, windowEnd: Date): Promise<TwitterSourceOutcome> {
	let window: TwitterSearchWindow | null = null;
	try {
		window = twitterSearchWindow(source.scrapedAt ?? source.createdAt, windowEnd, TWITTER_WATERMARK_OVERLAP_MS);
		const fetched = await fetchTweetsForSource(env.KAITO_API_KEY, source.handle, window);
		const saved = await saveTweets(env, fetched.tweets, source);
		const errors = [...fetched.errors, ...saved.errors];
		if (errors.length) await recordSourceFailure(env, source.id, twitterSourceFailure(source.handle, errors));
		const outcome: TwitterSourceOutcome = {
			admittedDrafts: saved.admittedDrafts,
			complete: errors.length === 0,
			counts: saved.counts,
			errors,
			normalizedTweets: fetched.tweets.length,
			pages: fetched.pages,
			providerTweets: fetched.providerTweets,
			searches: fetched.searches,
			sourceId: source.id,
		};
		console.info({
			tag: 'TWITTER',
			event: 'twitter_source_processed',
			userName: source.handle,
			since_time: window.sinceTime,
			until_time: window.untilTime,
			pages: outcome.pages,
			searches: outcome.searches,
			provider_tweets: outcome.providerTweets,
			normalized_tweets: outcome.normalizedTweets,
			admitted_drafts: outcome.admittedDrafts,
			...outcome.counts,
			errors: errors.length,
		});
		return outcome;
	} catch (error) {
		await recordSourceFailure(env, source.id, error);
		console.error({
			tag: 'TWITTER',
			event: 'twitter_source_failed',
			userName: source.handle,
			...(window ? { since_time: window.sinceTime, until_time: window.untilTime } : {}),
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			admittedDrafts: 0,
			complete: false,
			counts: emptyTwitterAdmissionCounts(),
			errors: [error],
			normalizedTweets: 0,
			pages: 0,
			providerTweets: 0,
			searches: 0,
			sourceId: source.id,
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
	searches: number;
	supersededSources: number;
	systemFailures: unknown[];
};

async function processTwitterSources(env: CoreEnv, sources: MonitoredSource[], windowEnd: Date): Promise<TwitterMonitorOutcome> {
	const outcomes: TwitterSourceOutcome[] = [];
	for (let offset = 0; offset < sources.length; offset += TWITTER_SOURCE_CONCURRENCY) {
		const group = sources.slice(offset, offset + TWITTER_SOURCE_CONCURRENCY);
		outcomes.push(...(await Promise.all(group.map((source) => processTwitterSource(env, source, windowEnd)))));
	}

	const completedSourceIds = outcomes.filter((outcome) => outcome.complete).map((outcome) => outcome.sourceId);
	const systemFailures = outcomes.flatMap((outcome) => outcome.errors);
	let advancedSources = 0;
	let watermarkFailures = 0;
	if (completedSourceIds.length) {
		try {
			advancedSources = await markSourcesScraped(env, completedSourceIds, windowEnd);
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
		for (const status of TWITTER_ADMISSION_STATUSES) counts[status] += outcome.counts[status];
	}
	return {
		admittedDrafts: outcomes.reduce((total, outcome) => total + outcome.admittedDrafts, 0),
		advancedSources,
		counts,
		incompleteSources: outcomes.filter((outcome) => !outcome.complete).length + watermarkFailures,
		normalizedTweets: outcomes.reduce((total, outcome) => total + outcome.normalizedTweets, 0),
		pages: outcomes.reduce((total, outcome) => total + outcome.pages, 0),
		providerTweets: outcomes.reduce((total, outcome) => total + outcome.providerTweets, 0),
		searches: outcomes.reduce((total, outcome) => total + outcome.searches, 0),
		supersededSources: completedSourceIds.length - advancedSources - watermarkFailures,
		systemFailures,
	};
}

export async function handleTwitterCron(env: CoreEnv, windowEnd: Date = new Date()): Promise<void> {
	if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
	if (!Number.isFinite(windowEnd.getTime())) throw new Error('Twitter monitor window end is invalid');
	console.info({ tag: 'TWITTER', msg: 'start', window_end: windowEnd.toISOString() });
	const sources = await loadMonitoredSources(env, 'twitter');
	if (!sources.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
		return;
	}

	const groups = Math.ceil(sources.length / TWITTER_SOURCE_CONCURRENCY);
	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', sources: sources.length, groups });
	const outcome = await processTwitterSources(env, sources, windowEnd);

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		sources: sources.length,
		groups,
		provider_tweets: outcome.providerTweets,
		normalized_tweets: outcome.normalizedTweets,
		pages: outcome.pages,
		searches: outcome.searches,
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
