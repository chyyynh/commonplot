import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { PostKindMetadata, ResourceCreator, ResourceMediaAttachment } from '@core-shared/resource';
import { extractTweetId } from '@core-shared/url';
import {
	literalCreator,
	materializePlatformResource,
	type PlatformAcquiredMaterial,
	type ResolvedResource,
	type ResourceAcquisitionHints,
} from './materialize';
import { parseTwitterArticleResponse, parseTwitterTweetsResponse, renderTwitterArticleMarkdown, type Tweet } from './twitter-data';

interface TwitterMedia {
	url: string;
	type: 'photo' | 'video' | 'animated_gif';
	videoUrl?: string;
	width?: number;
	height?: number;
}

interface TwitterAuthorFields {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

interface QuotedTweetData {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	text: string;
}

interface TwitterMetadata extends TwitterAuthorFields {
	media?: TwitterMedia[];
	quotedTweet?: QuotedTweetData;
}

type TwitterAcquiredMaterial = Omit<PlatformAcquiredMaterial<'twitter'>, 'kindMetadata' | 'platformId'> & {
	kindMetadata: PostKindMetadata;
};
type TwitterResourceFields = Pick<TwitterAcquiredMaterial, 'creators' | 'kindMetadata' | 'subjectUrl'>;

function requiredTweetAuthor(tweet: Tweet): NonNullable<Tweet['author']> {
	if (!tweet.author?.userName.trim() || !tweet.author.name.trim()) {
		throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
	}
	return tweet.author;
}

const NON_RESOURCE_LINK_HOSTS = new Set(['twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net']);

function isNonResourceLinkUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname.startsWith('www.')) hostname = hostname.slice(4);
	for (const host of NON_RESOURCE_LINK_HOSTS) {
		if (hostname === host || hostname.endsWith(`.${host}`)) return true;
	}
	return false;
}

function extractTweetAuthor(tweet: Tweet): TwitterAuthorFields {
	const author = requiredTweetAuthor(tweet);
	return {
		authorName: author.name,
		authorUserName: author.userName,
		authorProfilePicture: author.profilePicture,
		authorVerified: author.isBlueVerified,
	};
}

function extractTweetMedia(tweet: Tweet): TwitterMedia[] {
	return (
		tweet.extendedEntities?.media?.flatMap((m) => {
			if (!m.media_url_https) return [];
			const result: TwitterMedia = { url: m.media_url_https, type: m.type as TwitterMedia['type'] };
			if (m.sizes?.large) {
				result.width = m.sizes.large.w;
				result.height = m.sizes.large.h;
			}
			if (m.video_info?.variants) {
				const mp4 = m.video_info.variants
					.filter((v): v is typeof v & { bitrate: number } => v.content_type === 'video/mp4' && Number.isFinite(v.bitrate))
					.sort((a, b) => b.bitrate - a.bitrate)[0];
				if (mp4) result.videoUrl = mp4.url;
			}
			return [result];
		}) ?? []
	);
}

function tweetUrlEntities(tweet: Tweet): Array<{ expanded_url?: string; url?: string }> {
	return tweet.urls ?? tweet.entities?.urls ?? [];
}

const TCO_TOKEN_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/g;

/**
 * Rewrite tweet text the way Twitter renders it: each t.co token becomes its
 * expanded URL. Tokens are dropped when Twitter hides them — media links
 * (expansions pointing at the tweet's own photo/video pages, or t.co with no
 * url entity at all) and a trailing link to the quoted tweet (the quote box
 * renders instead).
 */
function expandTweetUrls(text: string, tweet: Tweet): string {
	const replacements = new Map<string, string>();
	for (const entity of tweetUrlEntities(tweet)) {
		const token = entity.url?.trim();
		const expanded = entity.expanded_url?.trim();
		if (!token || !expanded) continue;
		replacements.set(token, /\/status\/\d+\/(?:photo|video)\/\d+/.test(expanded) ? '' : expanded);
	}
	const quoted = tweet.quoted_tweet;
	const quotedTweetId = quoted ? quoted.id?.trim() || extractTweetId(quoted.url) : null;
	const trailing = text.match(/(https?:\/\/\S+)\s*$/)?.[1];
	if (quotedTweetId && trailing) {
		const expandedTrailing = replacements.get(trailing) ?? trailing;
		if (extractTweetId(expandedTrailing) === quotedTweetId) replacements.set(trailing, '');
	}
	return text
		.replace(TCO_TOKEN_RE, (token) => replacements.get(token) ?? '')
		.replace(/[^\S\n]+\n/g, '\n')
		.replace(/[^\S\n]{2,}/g, ' ')
		.trim();
}

/** Expand mapped t.co tokens only — for longform bodies, where unmapped t.co are the article's own links. */
function expandKnownTweetUrls(text: string, tweet: Tweet): string {
	const replacements = new Map<string, string>();
	for (const entity of tweetUrlEntities(tweet)) {
		const token = entity.url?.trim();
		const expanded = entity.expanded_url?.trim();
		if (token && expanded) replacements.set(token, expanded);
	}
	return text.replace(TCO_TOKEN_RE, (token) => replacements.get(token) ?? token);
}

function stripTrailingExternalUrl(text: string, externalUrl: string): string {
	const match = text.match(/(https?:\/\/\S+)\s*$/);
	if (!match || match.index === undefined) return text;
	const normalize = (value: string) => value.replace(/\/+$/, '');
	return normalize(match[1]) === normalize(externalUrl) ? text.slice(0, match.index).trimEnd() : text;
}

function stripTweetUrls(text: string): string {
	return text.replace(/https?:\/\/\S+/g, '').trim();
}

function extractQuotedTweet(tweet: Tweet): QuotedTweetData | undefined {
	const q = tweet.quoted_tweet;
	if (!q) return undefined;
	const authorName = q.author?.name?.trim();
	const authorUserName = q.author?.userName?.trim();
	const text = typeof q.text === 'string' ? expandTweetUrls(q.text, q) : '';
	if (!authorName || !authorUserName || !text) return undefined;
	return {
		authorName,
		authorUserName,
		authorProfilePicture: q.author?.profilePicture,
		text,
	};
}

export function buildTweetTitle(tweet: Tweet, maxLength = 100): string {
	const author = requiredTweetAuthor(tweet);
	// Titles are display/search strings: drop URLs entirely (expanded ones would
	// blow the length cap); URL-only tweets fall back to the raw text.
	const text = stripTweetUrls(tweet.text) || tweet.text.trim();
	if (!text) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no text`);
	const suffix = text.length > maxLength ? '...' : '';
	return `@${author.userName}: ${text.substring(0, maxLength)}${suffix}`;
}

function buildTweetFields(
	tweet: Tweet,
	options: {
		externalUrl?: string;
		media?: TwitterMedia[];
		quotedTweet?: QuotedTweetData;
	} = {},
): TwitterResourceFields {
	const media = options.media ?? extractTweetMedia(tweet);
	const metadata: TwitterMetadata = {
		...extractTweetAuthor(tweet),
		media,
		quotedTweet: options.quotedTweet ?? extractQuotedTweet(tweet),
	};
	return {
		creators: twitterCreator(metadata),
		kindMetadata: postMetadata(metadata),
		...(options.externalUrl ? { subjectUrl: options.externalUrl } : {}),
	};
}

function buildTwitterLongformFields(
	author: NonNullable<Tweet['author']>,
	coverImageUrl?: string,
): Pick<TwitterAcquiredMaterial, 'creators' | 'kindMetadata'> {
	const metadata: TwitterMetadata = {
		authorName: author.name,
		authorUserName: author.userName,
		authorProfilePicture: author.profilePicture,
		authorVerified: author.isBlueVerified,
		media: coverImageUrl ? [{ url: coverImageUrl, type: 'photo' }] : [],
	};
	return { creators: twitterCreator(metadata), kindMetadata: postMetadata(metadata) };
}

async function scrapeTwitterLongform(tweet: Tweet, apiKey: string): Promise<TwitterAcquiredMaterial> {
	const tweetId = tweet.id?.trim();
	if (!tweetId) throw new Error(`Could not resolve tweet id for Twitter article ${tweet.url}`);
	console.info({ tag: 'TWITTER', msg: 'Fetching longform for tweet', tweetId });

	const response = await fetch(`https://api.twitterapi.io/twitter/article?tweet_id=${tweetId}`, {
		headers: { 'x-api-key': apiKey },
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		const message = `Twitter longform request failed with HTTP ${response.status}`;
		if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
			throw new NonRetryableError(message);
		}
		throw new Error(message);
	}
	const longform = parseTwitterArticleResponse(await response.json(), tweetId);
	const title = longform.title?.trim();
	const contentText = expandKnownTweetUrls(renderTwitterArticleMarkdown(longform), tweet);
	if (!title || !contentText) throw new Error(`Twitter longform ${tweetId} requires both title and renderable content`);
	const tweetAuthor = requiredTweetAuthor(tweet);
	const author = {
		...tweetAuthor,
		...(longform.author?.name?.trim() ? { name: longform.author.name.trim() } : {}),
		...(longform.author?.userName?.trim() ? { userName: longform.author.userName.trim() } : {}),
		...(longform.author?.profilePicture ? { profilePicture: longform.author.profilePicture } : {}),
		...(longform.author?.isBlueVerified === null || longform.author?.isBlueVerified === undefined
			? {}
			: { isBlueVerified: longform.author.isBlueVerified }),
	};
	const publishedDate = longform.createdAt?.trim() || tweet.createdAt;
	if (Number.isNaN(new Date(publishedDate).getTime())) throw new Error(`Twitter longform ${tweetId} requires a valid published date`);

	console.info({ tag: 'TWITTER', msg: 'Longform fetched', title });

	return {
		resourcePlatform: 'twitter',
		fileType: null,
		title,
		markdown: contentText,
		source: 'Twitter',
		originalLang: tweet.lang ?? null,
		publishedDate,
		summary: null,
		...buildTwitterLongformFields(author, longform.cover_media_img_url ?? undefined),
	};
}

function buildExternalLinkTweet(tweet: Tweet, externalUrl: string, media: TwitterMedia[]): TwitterAcquiredMaterial {
	const author = requiredTweetAuthor(tweet);
	const tweetText = tweet.text.trim();
	if (!tweetText) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no text`);
	const title = `@${author.userName}: ${stripTweetUrls(tweetText) || tweetText}`.slice(0, 120);
	const expandedText = expandTweetUrls(tweetText, tweet);
	return {
		resourcePlatform: 'twitter',
		fileType: null,
		title,
		markdown: stripTrailingExternalUrl(expandedText, externalUrl),
		source: 'Twitter',
		originalLang: tweet.lang ?? null,
		publishedDate: tweet.createdAt,
		summary: null,
		...buildTweetFields(tweet, {
			media,
			externalUrl,
		}),
	};
}

async function resolveTweetContent(tweet: Tweet, apiKey: string): Promise<TwitterAcquiredMaterial> {
	const media = extractTweetMedia(tweet);
	const expandedUrls = tweetUrlEntities(tweet).flatMap((url) => {
		const expandedUrl = url.expanded_url?.trim();
		return expandedUrl ? [expandedUrl] : [];
	});
	const longformUrl = [tweet.url, ...expandedUrls].find((url): url is string => !!url && /(?:twitter\.com|x\.com)\/i\/article\//.test(url));
	const linkedContentUrl = expandedUrls.find((url) => !/t\.co/.test(url) && !isNonResourceLinkUrl(url));

	if (longformUrl) {
		console.info({ tag: 'TWITTER', msg: 'Detected Twitter longform', longformUrl });
		return scrapeTwitterLongform(tweet, apiKey);
	}

	if (linkedContentUrl) {
		return buildExternalLinkTweet(tweet, linkedContentUrl, media);
	}

	const author = requiredTweetAuthor(tweet);
	const title = buildTweetTitle(tweet, 80);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: author.userName });

	return {
		resourcePlatform: 'twitter',
		fileType: null,
		title,
		markdown: expandTweetUrls(tweet.text, tweet),
		source: 'Twitter',
		originalLang: tweet.lang ?? null,
		publishedDate: tweet.createdAt,
		summary: null,
		...buildTweetFields(tweet),
	};
}

async function scrapeTweet(tweetId: string, apiKey: string): Promise<PlatformAcquiredMaterial<'twitter'>> {
	console.info({ tag: 'TWITTER', msg: 'Fetching tweet', tweetId });
	const response = await fetch(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${tweetId}`, {
		headers: { 'x-api-key': apiKey },
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		const message =
			response.status === 404 || response.status === 410
				? `Twitter API: Tweet ${tweetId} was not found`
				: `HTTP ${response.status}: ${response.statusText}`;
		if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
			throw new NonRetryableError(message);
		}
		throw new Error(message);
	}
	const tweets = parseTwitterTweetsResponse(await response.json());
	const tweet = tweets[0];
	if (!tweet) throw new NonRetryableError(`Twitter API: Tweet ${tweetId} was not found`);
	return { ...(await resolveTweetContent(tweet, apiKey)), platformId: tweetId };
}

export async function stageTwitterAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		hints: ResourceAcquisitionHints;
		processingId: string;
		tweetId: string;
	},
): Promise<ResolvedResource> {
	const contentStream = await step.do(
		'acquire-twitter-v1',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async (ctx) => {
			console.info({
				tag: 'TWITTER',
				event: 'acquisition_attempt',
				processing_id: input.processingId,
				attempt: ctx.attempt,
			});
			return Response.json(await scrapeTweet(input.tweetId, env.KAITO_API_KEY)).body!;
		},
	);
	return materializePlatformResource(await new Response(contentStream).json<PlatformAcquiredMaterial<'twitter'>>(), input.hints, {
		kind: 'post',
		url: `https://x.com/i/status/${input.tweetId}`,
	});
}

function twitterCreator(data: TwitterMetadata): ResourceCreator[] {
	const handle = data.authorUserName?.replace(/^@/, '').trim();
	const profileUrl = handle ? `https://x.com/${encodeURIComponent(handle)}` : undefined;
	return literalCreator('author', data.authorName || handle, {
		...(handle ? { handle } : {}),
		...(data.authorProfilePicture?.trim() ? { avatarUrl: data.authorProfilePicture.trim() } : {}),
		...(profileUrl ? { profileUrl } : {}),
		...(data.authorVerified === undefined ? {} : { verified: data.authorVerified }),
	});
}

function postMetadata(data: TwitterMetadata): PostKindMetadata {
	const attachments: ResourceMediaAttachment[] = (data.media ?? []).flatMap((media) => {
		if (!media.url?.trim()) return [];
		return [
			{
				kind: media.type === 'photo' ? 'image' : media.type === 'animated_gif' ? 'animated' : 'video',
				url: media.url.trim(),
				...(media.videoUrl?.trim() ? { videoUrl: media.videoUrl.trim() } : {}),
				...(media.width === undefined ? {} : { width: media.width }),
				...(media.height === undefined ? {} : { height: media.height }),
			},
		];
	});
	const quoted = data.quotedTweet;
	const quoteHandle = quoted?.authorUserName?.replace(/^@/, '').trim();
	const quoteCreator = quoted
		? literalCreator('author', quoted.authorName || quoted.authorUserName, {
				...(quoteHandle ? { handle: quoteHandle } : {}),
				...(quoted.authorProfilePicture?.trim() ? { avatarUrl: quoted.authorProfilePicture.trim() } : {}),
				...(quoteHandle ? { profileUrl: `https://x.com/${encodeURIComponent(quoteHandle)}` } : {}),
			})[0]
		: undefined;
	return {
		attachments,
		...(quoted?.text.trim() && quoteCreator ? { quote: { creator: quoteCreator, text: quoted.text.trim() } } : {}),
	};
}
