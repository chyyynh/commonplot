import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { PhrasingContent, Root } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { cjkFriendlyToMarkdown } from 'mdast-util-to-markdown-cjk-friendly';
import { cjkFriendlyGfmStrikethroughToMarkdown } from 'mdast-util-to-markdown-cjk-friendly-gfm-strikethrough';
import { z } from 'zod';
import type { AcquiredResource } from '../acquisition';
import { resolveResourceUrl, ResourceUrlSchema } from './resource-url';

const TwitterAuthorSchema = z.object({
	userName: z.string(),
	name: z.string(),
	profilePicture: z.string().optional(),
	isBlueVerified: z.boolean().optional(),
});

const TwitterUrlEntitySchema = z.object({
	expanded_url: z.string().optional(),
	url: z.string().optional(),
});

const TwitterMediaEntitySchema = z.object({
	media_url_https: z.string(),
	type: z.string(),
	video_info: z
		.object({
			variants: z.array(z.object({ url: z.string(), content_type: z.string(), bitrate: z.number().nonnegative().optional() })),
		})
		.optional(),
	sizes: z
		.object({
			large: z.object({ w: z.number(), h: z.number() }).optional(),
		})
		.optional(),
});

const TweetSchema = z.object({
	id: z.string().regex(/^\d+$/),
	url: z.string().min(1),
	createdAt: z.string().min(1),
	author: TwitterAuthorSchema.optional(),
	text: z.string(),
	extendedEntities: z.object({ media: z.array(TwitterMediaEntitySchema).optional() }).optional(),
	entities: z.object({ urls: z.array(TwitterUrlEntitySchema).optional() }).optional(),
	lang: z.string().max(35).optional(),
	get quoted_tweet(): z.ZodCatch<z.ZodOptional<z.ZodNullable<typeof TweetSchema>>> {
		return TweetSchema.nullish().catch(null);
	},
});

type Tweet = z.infer<typeof TweetSchema>;

const TwitterTweetsResponseSchema = z.object({
	tweets: z.array(TweetSchema),
	status: z.string().optional(),
	msg: z.string().optional(),
	message: z.string().optional(),
});

const TwitterArticleInlineStyleSchema = z.object({
	offset: z.int().nonnegative(),
	length: z.int().nonnegative(),
	style: z.string(),
});

const TwitterArticleContentSchema = z.object({
	type: z.enum([
		'unstyled',
		'header-one',
		'header-two',
		'header-three',
		'unordered-list-item',
		'ordered-list-item',
		'image',
		'gif',
		'markdown',
		'divider',
	]),
	text: z.string().nullish(),
	url: z.string().nullish(),
	previewUrl: z.string().nullish(),
	inlineStyleRanges: z.array(TwitterArticleInlineStyleSchema).nullish(),
});

const TwitterArticleSchema = z.object({
	title: z.string().nullish(),
	cover_media_img_url: z.string().nullish(),
	contents: z.array(TwitterArticleContentSchema).nullish(),
	author: z
		.object({
			userName: z.string().nullish(),
			name: z.string().nullish(),
			isBlueVerified: z.boolean().nullish(),
			profilePicture: z.string().nullish(),
		})
		.nullish(),
	createdAt: z.string().nullish(),
});

const TwitterArticleResponseSchema = z.object({
	article: TwitterArticleSchema.nullish(),
	status: z.enum(['success', 'failed']),
	message: z.string().optional(),
});

type TwitterArticle = z.infer<typeof TwitterArticleSchema>;
type TwitterArticleContent = NonNullable<TwitterArticle['contents']>[number];

const ARTICLE_INLINE_STYLES = {
	bold: 'strong',
	italic: 'emphasis',
	strikethrough: 'delete',
	code: 'inlineCode',
	monospace: 'inlineCode',
} as const;

function styledArticleText(block: TwitterArticleContent): PhrasingContent[] {
	const text = block.text ?? '';
	const ranges = (block.inlineStyleRanges ?? []).flatMap(({ offset, length, style }) => {
		const type = ARTICLE_INLINE_STYLES[style.trim().toLowerCase() as keyof typeof ARTICLE_INLINE_STYLES];
		return type && length > 0 && offset + length <= text.length ? [{ start: offset, end: offset + length, type }] : [];
	});
	const boundaries = [...new Set([0, text.length, ...ranges.flatMap(({ start, end }) => [start, end])])].sort((a, b) => a - b);
	const children: PhrasingContent[] = [];
	for (let index = 1; index < boundaries.length; index++) {
		const start = boundaries[index - 1]!;
		const end = boundaries[index]!;
		const styles = new Set(ranges.filter((range) => range.start <= start && range.end >= end).map(({ type }) => type));
		let target = children;
		// Reuse adjacent containers so overlapping provider ranges remain valid Markdown nesting.
		for (const type of ['strong', 'emphasis', 'delete'] as const) {
			if (!styles.has(type)) continue;
			const previous = target.at(-1);
			if (previous?.type === type && 'children' in previous) target = previous.children;
			else {
				const children: PhrasingContent[] = [];
				target.push({ type, children });
				target = children;
			}
		}
		const type = styles.has('inlineCode') ? 'inlineCode' : 'text';
		const value = text.slice(start, end);
		const previous = target.at(-1);
		if (previous?.type === type) previous.value += value;
		else target.push({ type, value });
	}
	return children;
}

function renderTwitterArticleBlock(block: TwitterArticleContent): string {
	if (block.type === 'markdown') return block.text?.trim() ?? '';
	const children = styledArticleText(block);
	const tree: Root = { type: 'root', children: [] };
	switch (block.type) {
		case 'header-one':
		case 'header-two':
		case 'header-three':
			if (block.text?.trim())
				tree.children.push({ type: 'heading', depth: block.type === 'header-one' ? 1 : block.type === 'header-two' ? 2 : 3, children });
			break;
		case 'unordered-list-item':
		case 'ordered-list-item':
			if (block.text?.trim())
				tree.children.push({
					type: 'list',
					ordered: block.type === 'ordered-list-item',
					children: [{ type: 'listItem', children: [{ type: 'paragraph', children }] }],
				});
			break;
		case 'image':
			if (block.url) tree.children.push({ type: 'paragraph', children: [{ type: 'image', url: block.url, alt: '' }] });
			break;
		case 'gif':
			if (block.previewUrl) tree.children.push({ type: 'paragraph', children: [{ type: 'image', url: block.previewUrl, alt: 'GIF' }] });
			if (block.url)
				tree.children.push({ type: 'paragraph', children: [{ type: 'link', url: block.url, children: [{ type: 'text', value: 'GIF' }] }] });
			break;
		case 'divider':
			tree.children.push({ type: 'thematicBreak' });
			break;
		case 'unstyled':
			if (block.text?.trim()) tree.children.push({ type: 'paragraph', children });
	}
	return toMarkdown(tree, {
		emphasis: '_',
		extensions: [gfmToMarkdown(), cjkFriendlyToMarkdown(), cjkFriendlyGfmStrikethroughToMarkdown()],
	}).trimEnd();
}

function renderTwitterArticleMarkdown(article: TwitterArticle): string {
	let markdown = '';
	let previous: TwitterArticleContent | undefined;
	for (const block of article.contents ?? []) {
		const rendered = renderTwitterArticleBlock(block);
		if (!rendered) continue;
		const sameList = previous?.type === block.type && (block.type === 'unordered-list-item' || block.type === 'ordered-list-item');
		markdown += `${markdown ? (sameList ? '\n' : '\n\n') : ''}${rendered}`;
		previous = block;
	}
	return markdown;
}

type TwitterAcquisitionInput = {
	processingId: string;
	tweetId: string;
};

function requiredTweetAuthor(tweet: Tweet): NonNullable<Tweet['author']> {
	if (!tweet.author?.userName.trim() || !tweet.author.name.trim()) {
		throw new Error(`Tweet ${tweet.id} has no complete author`);
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
			const playback =
				media.type === 'photo'
					? undefined
					: media.video_info?.variants
							.flatMap((variant) => {
								const type = variant.content_type.toLowerCase();
								const src = ResourceUrlSchema.safeParse(variant.url).data;
								return src && (type === 'video/mp4' || type === 'application/x-mpegurl')
									? [{ url: src, type, bitrate: variant.bitrate ?? 0 } as const]
									: [];
							})
							.sort((a, b) => Number(b.type === 'video/mp4') - Number(a.type === 'video/mp4') || b.bitrate - a.bitrate)[0];
			return [
				{
					kind: media.type === 'photo' ? 'image' : media.type === 'animated_gif' ? 'animated' : 'video',
					url,
					...(playback ? { playback: { url: playback.url, type: playback.type } } : {}),
					...(media.sizes?.large ? { width: media.sizes.large.w, height: media.sizes.large.h } : {}),
				} as const,
			];
		}) ?? []
	);
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
	for (const entity of tweet.entities?.urls ?? []) {
		const token = entity.url?.trim();
		const expanded = entity.expanded_url?.trim();
		if (!token || !expanded) continue;
		const parsed = URL.parse(expanded);
		const mediaLink =
			parsed && resolveResourceUrl(expanded)?.resourcePlatform === 'twitter' && /\/status\/\d+\/(?:photo|video)\/\d+/.test(parsed.pathname);
		replacements.set(token, mediaLink ? '' : expanded);
	}
	const quotedTweetId = tweet.quoted_tweet?.id;
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
	for (const entity of tweet.entities?.urls ?? []) {
		const token = entity.url?.trim();
		const expanded = entity.expanded_url?.trim();
		if (token && expanded) replacements.set(token, expanded);
	}
	return text.replace(TCO_TOKEN_RE, (token) => replacements.get(token) ?? token);
}

/** The quoted tweet is its own Resource; the quote box renders from that subject. */
function quotedTweetUrl(tweet: Tweet): string | undefined {
	const quote = tweet.quoted_tweet;
	if (!quote) return undefined;
	const identifier = resolveResourceUrl(quote.url)?.identifiers.find(({ scheme }) => scheme === 'twitter');
	return identifier?.value === quote.id ? quote.url : undefined;
}

async function scrapeTwitterLongform(tweet: Tweet, apiKey: string) {
	const tweetId = tweet.id;
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
	const payload = TwitterArticleResponseSchema.parse(await response.json());
	if (payload.status !== 'success') {
		throw new Error(`Twitter article ${tweetId} failed: ${payload.message?.trim() || 'unknown provider error'}`);
	}
	const longform = payload.article;
	if (!longform) throw new Error(`Twitter article ${tweetId} omitted article content`);
	const title = longform.title?.trim();
	const contentText = expandKnownTweetUrls(renderTwitterArticleMarkdown(longform), tweet);
	if (!title || !contentText) throw new Error(`Twitter longform ${tweetId} requires both title and renderable content`);
	const tweetAuthor = requiredTweetAuthor(tweet);
	// Sharing someone else's Article keeps the tweet a post; only the author's own Article is this Resource.
	const articleHandle = longform.author?.userName?.trim().toLowerCase();
	if (articleHandle && articleHandle !== tweetAuthor.userName.trim().toLowerCase()) return null;
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
		kind: 'blog' as const,
		title,
		content: contentText,
		publishedDate,
		creators: [twitterCreator(author)],
		kindMetadata: null,
		previewImageUrl: longform.cover_media_img_url?.trim() || null,
		subjectUrl: null,
	};
}

async function resolveTweetContent(tweet: Tweet, apiKey: string) {
	const expandedUrls = (tweet.entities?.urls ?? []).flatMap((url) => {
		const expandedUrl = url.expanded_url?.trim();
		return expandedUrl ? [expandedUrl] : [];
	});
	const longformUrl = [tweet.url, ...expandedUrls].find((url) => {
		const parsed = URL.parse(url);
		return parsed && /(^|\.)(twitter|x)\.com$/.test(parsed.hostname) && parsed.pathname.startsWith('/i/article/');
	});
	const linkedContentUrl = expandedUrls.find((url) => !isNonResourceLinkUrl(url));
	// X shows the quote box instead of a link card, so the quote wins.
	const subjectUrl = quotedTweetUrl(tweet) ?? linkedContentUrl ?? null;

	if (longformUrl) {
		console.info({ tag: 'TWITTER', msg: 'Detected Twitter longform', longformUrl });
		const longform = await scrapeTwitterLongform(tweet, apiKey);
		if (longform) return longform;
	}

	const author = requiredTweetAuthor(tweet);
	const text = tweet.text.trim();
	if (!text) throw new Error(`Tweet ${tweet.id} has no text`);
	const content = expandTweetUrls(text, tweet);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: author.userName });

	// A post is its author and text; it has no title or summary.
	return {
		kind: 'post' as const,
		title: null,
		content,
		publishedDate: tweet.createdAt,
		creators: [twitterCreator(author)],
		kindMetadata: { attachments: tweetAttachments(tweet) },
		previewImageUrl: null,
		subjectUrl,
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
	const payload = TwitterTweetsResponseSchema.parse(await response.json());
	if (payload.status?.toLowerCase() === 'error') {
		throw new Error(`Twitter tweets request failed: ${(payload.message ?? payload.msg)?.trim() || 'unknown provider error'}`);
	}
	if (!payload.tweets.length) throw new NonRetryableError(`Twitter API: Tweet ${tweetId} was not found`);
	const tweet = payload.tweets.find((tweet) => tweet.id === tweetId);
	if (!tweet) throw new Error(`Twitter API returned no matching tweet for ${tweetId}`);
	const { subjectUrl, ...content } = await resolveTweetContent(tweet, apiKey);

	return {
		...content,
		resourcePlatform: 'twitter',
		resourceIdentifiers: [{ preferred: true, scheme: 'twitter', value: tweetId }],
		url: `https://x.com/i/status/${tweetId}`,
		source: 'Twitter',
		originalLang: tweet.lang ?? 'und',
		summary: null,
		fileType: null,
		subjectUrl: ResourceUrlSchema.safeParse(subjectUrl).data ?? null,
	} satisfies AcquiredResource;
}

export async function stageTwitterAcquisition(env: CoreEnv, step: WorkflowStep, input: TwitterAcquisitionInput) {
	const contentStream = await step.do(
		'acquire-twitter-v3',
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
	const handle = author.userName.replace(/^\s*@/, '').trim();
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
