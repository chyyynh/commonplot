import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { AcquiredResource } from '../acquisition';
import { resolveResourceUrl } from './resource-url';
import { parseTwitterArticleResponse, parseTwitterTweetsResponse, renderTwitterArticleMarkdown, type Tweet } from './twitter-data';

type TwitterAcquisitionInput = {
	processingId: string;
	tweetId: string;
};

function requiredTweetAuthor(tweet: Tweet): NonNullable<Tweet['author']> {
	if (!tweet.author?.userName.trim() || !tweet.author.name.trim()) {
		throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
	}
	return tweet.author;
}

const NON_RESOURCE_LINK_HOSTS = ['t.co', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net'];

function isNonResourceLinkUrl(url: string): boolean {
	const hostname = URL.parse(url)?.hostname;
	return !hostname || NON_RESOURCE_LINK_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function tweetAttachments(tweet: Tweet) {
	return (
		tweet.extendedEntities?.media?.flatMap((media) => {
			const url = media.media_url_https.trim();
			if (!url) return [];
			return [
				{
					kind: media.type === 'photo' ? 'image' : media.type === 'animated_gif' ? 'animated' : 'video',
					url,
					...(media.sizes?.large ? { width: media.sizes.large.w, height: media.sizes.large.h } : {}),
				} as const,
			];
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
		const parsed = URL.parse(expanded);
		const mediaLink =
			parsed && resolveResourceUrl(expanded)?.resourcePlatform === 'twitter' && /\/status\/\d+\/(?:photo|video)\/\d+/.test(parsed.pathname);
		replacements.set(token, mediaLink ? '' : expanded);
	}
	const quoted = tweet.quoted_tweet;
	const quotedTweetId = quoted
		? quoted.id?.trim() || resolveResourceUrl(quoted.url)?.identifiers.find(({ scheme }) => scheme === 'twitter')?.value
		: null;
	const trailing = text.match(/(https?:\/\/\S+)\s*$/)?.[1];
	if (quotedTweetId && trailing) {
		const expandedTrailing = replacements.get(trailing) ?? trailing;
		if (resolveResourceUrl(expandedTrailing)?.identifiers.find(({ scheme }) => scheme === 'twitter')?.value === quotedTweetId) {
			replacements.set(trailing, '');
		}
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
	return match[1].replace(/\/+$/, '') === externalUrl.replace(/\/+$/, '') ? text.slice(0, match.index).trimEnd() : text;
}

function tweetQuote(tweet: Tweet) {
	const quote = tweet.quoted_tweet;
	const author = quote?.author;
	if (!quote || !author?.name.trim() || !author.userName.trim()) return undefined;
	const text = expandTweetUrls(quote.text, quote);
	const creator = twitterCreator({ name: author.name.trim(), userName: author.userName.trim(), profilePicture: author.profilePicture });
	return text ? { creator, text } : undefined;
}

async function scrapeTwitterLongform(tweet: Tweet, apiKey: string) {
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
	const coverImageUrl = longform.cover_media_img_url?.trim();

	console.info({ tag: 'TWITTER', msg: 'Longform fetched', title });

	return {
		title,
		content: contentText,
		publishedDate,
		creators: [twitterCreator(author)],
		kindMetadata: { attachments: coverImageUrl ? [{ kind: 'image' as const, url: coverImageUrl }] : [] },
		subjectUrl: null,
	};
}

async function resolveTweetContent(tweet: Tweet, apiKey: string) {
	const expandedUrls = tweetUrlEntities(tweet).flatMap((url) => {
		const expandedUrl = url.expanded_url?.trim();
		return expandedUrl ? [expandedUrl] : [];
	});
	const longformUrl = [tweet.url, ...expandedUrls].find((url) => {
		const parsed = URL.parse(url);
		return parsed && resolveResourceUrl(url)?.resourcePlatform === 'twitter' && parsed.pathname.startsWith('/i/article/');
	});
	const linkedContentUrl = expandedUrls.find((url) => !isNonResourceLinkUrl(url));

	if (longformUrl) {
		console.info({ tag: 'TWITTER', msg: 'Detected Twitter longform', longformUrl });
		return scrapeTwitterLongform(tweet, apiKey);
	}

	const author = requiredTweetAuthor(tweet);
	const text = tweet.text.trim();
	if (!text) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no text`);
	// Titles omit URLs unless the tweet contains only a URL.
	const titleText = text.replace(/https?:\/\/\S+/g, '').trim() || text;
	const title = linkedContentUrl
		? `@${author.userName}: ${titleText}`.slice(0, 120)
		: `@${author.userName}: ${titleText.slice(0, 80)}${titleText.length > 80 ? '...' : ''}`;
	const content = expandTweetUrls(text, tweet);
	const quote = tweetQuote(tweet);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: author.userName });

	return {
		title,
		content: linkedContentUrl ? stripTrailingExternalUrl(content, linkedContentUrl) : content,
		publishedDate: tweet.createdAt,
		creators: [twitterCreator(author)],
		kindMetadata: { attachments: tweetAttachments(tweet), ...(quote ? { quote } : {}) },
		subjectUrl: linkedContentUrl,
	};
}

async function scrapeTweet({ tweetId }: TwitterAcquisitionInput, apiKey: string) {
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
	const { subjectUrl, ...content } = await resolveTweetContent(tweet, apiKey);

	const subject = resolveResourceUrl(subjectUrl);
	return {
		...content,
		kind: 'post',
		resourcePlatform: 'twitter',
		resourceIdentifiers: [{ preferred: true, scheme: 'twitter', value: tweetId }],
		url: `https://x.com/i/status/${tweetId}`,
		title: content.title.trim(),
		source: 'Twitter',
		originalLang: tweet.lang ?? 'und',
		summary: null,
		fileType: null,
		previewImageUrl: null,
		subject,
	} satisfies AcquiredResource;
}

export async function stageTwitterAcquisition(env: CoreEnv, step: WorkflowStep, input: TwitterAcquisitionInput) {
	const contentStream = await step.do(
		'acquire-twitter-v2',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async (ctx) => {
			console.info({
				tag: 'TWITTER',
				event: 'acquisition_attempt',
				processing_id: input.processingId,
				attempt: ctx.attempt,
			});
			return Response.json(await scrapeTweet(input, env.KAITO_API_KEY)).body!;
		},
	);
	return new Response(contentStream).json<Awaited<ReturnType<typeof scrapeTweet>>>();
}

function twitterCreator(author: NonNullable<Tweet['author']>) {
	const handle = author.userName.replace(/^@/, '').trim();
	const profileUrl = handle ? `https://x.com/${encodeURIComponent(handle)}` : undefined;
	return {
		role: 'author' as const,
		literal: author.name.trim(),
		...(handle ? { handle } : {}),
		...(author.profilePicture?.trim() ? { avatarUrl: author.profilePicture.trim() } : {}),
		...(profileUrl ? { profileUrl } : {}),
		...(author.isBlueVerified === undefined ? {} : { verified: author.isBlueVerified }),
	};
}
