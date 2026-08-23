import { z } from 'zod';

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
	sizes: z
		.object({
			large: z.object({ w: z.number(), h: z.number() }).optional(),
		})
		.optional(),
	video_info: z
		.object({
			variants: z
				.array(
					z.object({
						bitrate: z.number().optional(),
						content_type: z.string().optional(),
						url: z.string(),
					}),
				)
				.optional(),
		})
		.optional(),
});

interface RetweetedByData {
	authorUserName: string;
}

// twitterapi.io tweet response shape used inside the Twitter platform only.
export interface Tweet {
	id?: string;
	url: string;
	createdAt: string;
	author?: {
		userName: string;
		name: string;
		profilePicture?: string;
		isBlueVerified?: boolean;
	};
	text: string;
	extendedEntities?: {
		media?: Array<{
			media_url_https: string;
			type: string;
			sizes?: { large?: { w: number; h: number } };
			video_info?: { variants?: Array<{ bitrate?: number; content_type?: string; url: string }> };
		}>;
	};
	hashTags?: string[];
	urls?: Array<{ expanded_url?: string; url?: string }>;
	entities?: { urls?: Array<{ expanded_url?: string; url?: string }> };
	lang?: string;
	quoted_tweet?: Tweet | null;
	retweeted_tweet?: Tweet | null;
	retweetedBy?: RetweetedByData;
}

const RetweetedByDataSchema = z.object({
	authorUserName: z.string(),
});

const TweetSchema: z.ZodType<Tweet> = z.lazy(() =>
	z.object({
		id: z.string().optional(),
		url: z.string().min(1),
		createdAt: z.string().min(1),
		author: TwitterAuthorSchema.optional(),
		text: z.string(),
		extendedEntities: z.object({ media: z.array(TwitterMediaEntitySchema).optional() }).optional(),
		hashTags: z.array(z.string()).optional(),
		urls: z.array(TwitterUrlEntitySchema).optional(),
		entities: z.object({ urls: z.array(TwitterUrlEntitySchema).optional() }).optional(),
		lang: z.string().optional(),
		quoted_tweet: TweetSchema.nullish(),
		retweeted_tweet: TweetSchema.nullish(),
		retweetedBy: RetweetedByDataSchema.optional(),
	}),
);

const TwitterTweetsResponseSchema = z.object({
	tweets: z.array(TweetSchema),
	status: z.string().optional(),
	msg: z.string().optional(),
	message: z.string().optional(),
});

const TwitterArticleInlineStyleSchema = z.object({
	offset: z.number().int().nonnegative(),
	length: z.number().int().nonnegative(),
	style: z.string(),
});

const TwitterArticleContentSchema = z.object({
	type: z.string(),
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

export type TwitterArticle = z.infer<typeof TwitterArticleSchema>;
type TwitterArticleContent = NonNullable<TwitterArticle['contents']>[number];

const TwitterAdvancedSearchEnvelopeSchema = z.object({
	tweets: z.array(z.unknown()),
	has_next_page: z.boolean(),
	status: z.string().optional(),
	message: z.string().optional(),
	msg: z.string().optional(),
});
export type TwitterAdvancedSearchPage = {
	tweets: Tweet[];
	hasNextPage: boolean;
	rawTweetCount: number;
	invalidItems: Array<{ index: number; message: string }>;
};

export type TwitterSearchWindow = {
	sinceTime: number;
	untilTime: number;
};

const TWITTER_ADVANCED_SEARCH_PAGE_LIMIT = 20;

export function twitterSearchWindow(watermark: Date | string, windowEnd: Date, overlapMs: number): TwitterSearchWindow {
	const watermarkMs = new Date(watermark).getTime();
	const windowEndMs = windowEnd.getTime();
	if (!Number.isFinite(watermarkMs)) throw new Error('Twitter source has an invalid monitoring watermark');
	if (!Number.isFinite(windowEndMs)) throw new Error('Twitter monitor has an invalid window end');
	if (!Number.isSafeInteger(overlapMs) || overlapMs < 0) throw new Error('Twitter monitor has an invalid watermark overlap');
	const sinceTime = Math.floor((watermarkMs - overlapMs) / 1000);
	const untilTime = Math.floor(windowEndMs / 1000);
	if (sinceTime < 0 || sinceTime >= untilTime) throw new Error('Twitter monitoring window is empty or invalid');
	return { sinceTime, untilTime };
}

function assertTwitterSearchWindow(window: TwitterSearchWindow): void {
	if (
		!Number.isSafeInteger(window.sinceTime) ||
		!Number.isSafeInteger(window.untilTime) ||
		window.sinceTime < 0 ||
		window.sinceTime >= window.untilTime
	) {
		throw new Error('Twitter Advanced Search has an invalid time window');
	}
}

export function withTwitterSearchWindow(query: string, window: TwitterSearchWindow): string {
	assertTwitterSearchWindow(window);
	return `${query} since_time:${window.sinceTime} until_time:${window.untilTime}`;
}

/**
 * Advanced Search currently documents cursor pagination as unreliable. Move
 * the exclusive upper bound behind the oldest returned second instead, keeping
 * that second overlapped so posts sharing its timestamp cannot be skipped.
 */
export function nextTwitterSearchWindow(window: TwitterSearchWindow, tweets: readonly Tweet[], context: string): TwitterSearchWindow {
	assertTwitterSearchWindow(window);
	if (!tweets.length) throw new Error(`${context} returned an empty result before completion`);
	const timestamps = tweets.map((tweet) => {
		const timestamp = new Date(tweet.createdAt).getTime();
		if (!Number.isFinite(timestamp)) throw new Error(`${context} returned a tweet with an invalid creation time`);
		return Math.floor(timestamp / 1000);
	});
	const nextUntilTime = Math.min(...timestamps) + 1;
	if (!Number.isSafeInteger(nextUntilTime) || nextUntilTime <= window.sinceTime || nextUntilTime >= window.untilTime) {
		throw new Error(`${context} could not advance its Twitter Advanced Search time window`);
	}
	return { sinceTime: window.sinceTime, untilTime: nextUntilTime };
}

export function twitterSearchNeedsOlderWindow(page: Pick<TwitterAdvancedSearchPage, 'hasNextPage' | 'rawTweetCount'>): boolean {
	return page.hasNextPage || page.rawTweetCount >= TWITTER_ADVANCED_SEARCH_PAGE_LIMIT;
}

function semanticTwitterError(status: string | undefined, message: string | undefined): string | null {
	return status?.toLowerCase() === 'error' ? message?.trim() || 'unknown provider error' : null;
}

export function parseTwitterTweetsResponse(value: unknown): Tweet[] {
	const response = TwitterTweetsResponseSchema.parse(value);
	const error = semanticTwitterError(response.status, response.message ?? response.msg);
	if (error) throw new Error(`Twitter tweets request failed: ${error}`);
	return response.tweets;
}

export function parseTwitterArticleResponse(value: unknown, tweetId: string): TwitterArticle {
	const response = TwitterArticleResponseSchema.parse(value);
	if (response.status !== 'success') {
		throw new Error(`Twitter article ${tweetId} failed: ${response.message?.trim() || 'unknown provider error'}`);
	}
	if (!response.article) throw new Error(`Twitter article ${tweetId} omitted article content`);
	return response.article;
}

function articleStyleMarker(style: string): string | null {
	switch (style.trim().toLowerCase()) {
		case 'bold':
			return '**';
		case 'italic':
			return '_';
		case 'strikethrough':
			return '~~';
		case 'code':
		case 'monospace':
			return '`';
		default:
			return null;
	}
}

function styledArticleText(block: TwitterArticleContent): string {
	const text = block.text;
	if (!text?.trim()) return '';
	type Marker = { end: number; marker: string; start: number };
	const openings = new Map<number, Marker[]>();
	const closings = new Map<number, Marker[]>();
	for (const range of block.inlineStyleRanges ?? []) {
		const marker = articleStyleMarker(range.style);
		const start = range.offset;
		const end = start + range.length;
		if (!marker || range.length === 0 || end > text.length) continue;
		const item = { end, marker, start };
		openings.set(start, [...(openings.get(start) ?? []), item]);
		closings.set(end, [...(closings.get(end) ?? []), item]);
	}

	let markdown = '';
	for (let index = 0; index <= text.length; index++) {
		for (const item of (closings.get(index) ?? []).sort((left, right) => right.start - left.start)) markdown += item.marker;
		for (const item of (openings.get(index) ?? []).sort((left, right) => right.end - left.end)) markdown += item.marker;
		if (index < text.length) markdown += text[index];
	}
	return markdown.trim();
}

function renderTwitterArticleBlock(block: TwitterArticleContent): string {
	const text = styledArticleText(block);
	switch (block.type) {
		case 'header-one':
			return text ? `# ${text}` : '';
		case 'header-two':
			return text ? `## ${text}` : '';
		case 'header-three':
			return text ? `### ${text}` : '';
		case 'unordered-list-item':
			return text ? `- ${text}` : '';
		case 'ordered-list-item':
			return text ? `1. ${text}` : '';
		case 'image':
			return block.url ? `![](${block.url})` : '';
		case 'gif':
			return [block.previewUrl ? `![GIF](${block.previewUrl})` : '', block.url ? `[GIF](${block.url})` : ''].filter(Boolean).join('\n\n');
		case 'divider':
			return '---';
		case 'markdown':
		case 'unstyled':
			return text;
		default:
			return text || (block.url ? `[${block.type}](${block.url})` : '');
	}
}

function articleBlockIsListItem(block: TwitterArticleContent): boolean {
	return block.type === 'unordered-list-item' || block.type === 'ordered-list-item';
}

export function renderTwitterArticleMarkdown(article: TwitterArticle): string {
	let markdown = '';
	let previous: TwitterArticleContent | undefined;
	for (const block of article.contents ?? []) {
		const rendered = renderTwitterArticleBlock(block);
		if (!rendered) continue;
		const sameList = previous?.type === block.type && articleBlockIsListItem(block);
		markdown += `${markdown ? (sameList ? '\n' : '\n\n') : ''}${rendered}`;
		previous = block;
	}
	return markdown;
}

export function parseTwitterAdvancedSearchPage(value: unknown): TwitterAdvancedSearchPage {
	const response = TwitterAdvancedSearchEnvelopeSchema.parse(value);
	const error = semanticTwitterError(response.status, response.message ?? response.msg);
	if (error) throw new Error(`Twitter Advanced Search failed: ${error}`);
	const tweets: Tweet[] = [];
	const invalidItems: TwitterAdvancedSearchPage['invalidItems'] = [];
	for (const [index, item] of response.tweets.entries()) {
		const parsed = TweetSchema.safeParse(item);
		if (parsed.success) {
			tweets.push(parsed.data);
			continue;
		}
		const issue = parsed.error.issues[0];
		invalidItems.push({
			index,
			message: issue ? `${issue.path.join('.') || 'tweet'}: ${issue.message}` : 'Tweet is invalid',
		});
	}
	return {
		tweets,
		rawTweetCount: response.tweets.length,
		invalidItems,
		hasNextPage: response.has_next_page,
	};
}
