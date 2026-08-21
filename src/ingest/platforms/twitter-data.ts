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
	replyCount?: number;
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
	conversationId?: string;
	isReply?: boolean;
	inReplyToId?: string | null;
	inReplyToUsername?: string | null;
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
		replyCount: z.number().optional(),
		extendedEntities: z.object({ media: z.array(TwitterMediaEntitySchema).optional() }).optional(),
		hashTags: z.array(z.string()).optional(),
		urls: z.array(TwitterUrlEntitySchema).optional(),
		entities: z.object({ urls: z.array(TwitterUrlEntitySchema).optional() }).optional(),
		lang: z.string().optional(),
		conversationId: z.string().optional(),
		isReply: z.boolean().optional(),
		inReplyToId: z.string().nullable().optional(),
		inReplyToUsername: z.string().nullable().optional(),
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

const TwitterListPageSchema = z.object({
	tweets: z.array(TweetSchema),
	has_next_page: z.boolean(),
	next_cursor: z.string().optional(),
	status: z.string().optional(),
	message: z.string().optional(),
	msg: z.string().optional(),
});

const TwitterThreadContextPageSchema = z.object({
	tweets: z.array(TweetSchema).optional(),
	replies: z.array(TweetSchema).optional(),
	has_next_page: z.boolean(),
	next_cursor: z.string().optional(),
	status: z.string().optional(),
	message: z.string().optional(),
	msg: z.string().optional(),
});

export type TwitterListPage = {
	tweets: Tweet[];
	hasNextPage: boolean;
	nextCursor?: string;
};

export type TwitterThreadContextPageDecision = { kind: 'complete' | 'empty-page' } | { kind: 'next'; cursor: string };

export type TwitterSearchWindow = {
	sinceTime: number;
	untilTime: number;
};

export type TwitterMonitorSearch = {
	kind: 'posts' | 'self-replies';
	query: string;
};

const TWITTER_ADVANCED_SEARCH_PAGE_LIMIT = 20;

export function shouldRetryTwitterProviderStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

export function twitterProviderRetryDelayMs(retryAfter: string | null, attempt: number, nowMs = Date.now()): number {
	if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Twitter provider retry attempt must be a positive integer');
	const value = retryAfter?.trim();
	if (value && /^\d+$/.test(value)) return Math.min(Number(value) * 1000, 30_000);
	if (value) {
		const dateMs = Date.parse(value);
		if (Number.isFinite(dateMs) && dateMs > nowMs) return Math.min(dateMs - nowMs, 30_000);
	}
	return Math.min(1000 * 2 ** (attempt - 1), 8_000);
}

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

export function buildTwitterMonitorSearchQueries(userName: string): TwitterMonitorSearch[] {
	const normalized = userName.replace(/^@/, '').trim().toLowerCase();
	if (!/^[a-z0-9_]{1,15}$/.test(normalized)) throw new Error('Twitter source has an invalid handle');
	return [
		{ kind: 'posts', query: `from:${normalized} -filter:replies` },
		{ kind: 'self-replies', query: `from:${normalized} to:${normalized} filter:replies` },
	];
}

export function buildTwitterThreadSearchQuery(root: Tweet, tweetId: string): string {
	const conversationId = normalizedTweetId(root.conversationId) ?? normalizedTweetId(root.id) ?? normalizedTweetId(tweetId);
	if (!conversationId || !/^\d+$/.test(conversationId)) throw new Error(`Twitter thread ${tweetId} has an invalid conversation ID`);
	const author = normalizedTwitterUserName(root.author?.userName);
	if (!author || !/^[a-z0-9_]{1,15}$/.test(author)) throw new Error(`Twitter thread ${tweetId} has an invalid author handle`);
	return `conversation_id:${conversationId} from:${author} filter:replies`;
}

export function twitterThreadSearchWindow(root: Tweet, tweetId: string, windowEnd = new Date()): TwitterSearchWindow {
	const rootTime = new Date(root.createdAt).getTime();
	const windowEndTime = windowEnd.getTime();
	if (!Number.isFinite(rootTime)) throw new Error(`Twitter thread ${tweetId} has an invalid creation time`);
	if (!Number.isFinite(windowEndTime)) throw new Error(`Twitter thread ${tweetId} has an invalid search window end`);
	const window = {
		sinceTime: Math.max(0, Math.floor(rootTime / 1000) - 1),
		untilTime: Math.floor(windowEndTime / 1000) + 1,
	};
	assertTwitterSearchWindow(window);
	return window;
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

export function twitterSearchNeedsOlderWindow(page: TwitterListPage): boolean {
	return page.hasNextPage || page.tweets.length >= TWITTER_ADVANCED_SEARCH_PAGE_LIMIT;
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

export function combineTwitterThreadMarkdown(rootMarkdown: string, continuationMarkdown: string[]): string {
	return [rootMarkdown.trim(), ...continuationMarkdown.map((part) => part.trim())].filter(Boolean).join('\n\n');
}

export function parseTwitterAdvancedSearchPage(value: unknown): TwitterListPage {
	const response = TwitterListPageSchema.parse(value);
	const error = semanticTwitterError(response.status, response.message ?? response.msg);
	if (error) throw new Error(`Twitter Advanced Search failed: ${error}`);
	return {
		tweets: response.tweets,
		hasNextPage: response.has_next_page,
		...(response.next_cursor === undefined ? {} : { nextCursor: response.next_cursor }),
	};
}

export function parseTwitterThreadContextPage(value: unknown, tweetId: string): TwitterListPage {
	const response = TwitterThreadContextPageSchema.parse(value);
	const error = semanticTwitterError(response.status, response.message ?? response.msg);
	if (error) throw new Error(`Twitter thread context ${tweetId} failed: ${error}`);
	const tweets = response.tweets ?? response.replies;
	if (!tweets) throw new Error(`Twitter thread context ${tweetId} omitted tweets and replies`);
	return {
		tweets,
		hasNextPage: response.has_next_page,
		...(response.next_cursor === undefined ? {} : { nextCursor: response.next_cursor }),
	};
}

/**
 * Thread Context can report another page immediately before returning an empty
 * page. Treat that documented provider edge case as completion; every other
 * `hasNextPage` response must supply a fresh cursor so partial threads fail
 * loudly instead of being persisted.
 */
export function decideTwitterThreadContextNextPage(
	page: TwitterListPage,
	seenCursors: ReadonlySet<string>,
	tweetId: string,
): TwitterThreadContextPageDecision {
	if (!page.hasNextPage) return { kind: 'complete' };
	if (!page.tweets.length) return { kind: 'empty-page' };
	const cursor = page.nextCursor?.trim();
	if (!cursor) throw new Error(`Twitter thread context ${tweetId} omitted the next cursor`);
	if (seenCursors.has(cursor)) throw new Error(`Twitter thread context ${tweetId} returned a repeated cursor`);
	return { kind: 'next', cursor };
}

function normalizedTweetId(value: string | null | undefined): string | null {
	return value?.trim() || null;
}

function normalizedTwitterUserName(value: string | null | undefined): string | null {
	return value?.replace(/^@/, '').trim().toLowerCase() || null;
}

export function isTwitterReply(tweet: Tweet): boolean {
	if (tweet.isReply === true) return true;
	if (normalizedTweetId(tweet.inReplyToId) || normalizedTwitterUserName(tweet.inReplyToUsername)) return true;
	const tweetId = normalizedTweetId(tweet.id);
	const conversationId = normalizedTweetId(tweet.conversationId);
	return tweetId !== null && conversationId !== null && tweetId !== conversationId;
}

export function shouldSearchTwitterThread(tweet: Tweet, expectedReplyId?: string, discoverUnsignaledThread = true): boolean {
	if (expectedReplyId?.trim()) return true;
	return discoverUnsignaledThread && tweet.replyCount !== 0;
}

export function assertExpectedTwitterThreadPost(thread: Tweet[], expectedReplyId: string | undefined, tweetId: string): void {
	const expected = expectedReplyId?.trim();
	if (!expected) return;
	if (!/^\d+$/.test(expected)) throw new Error(`Twitter thread ${tweetId} has an invalid expected reply ID`);
	if (!thread.some((tweet) => normalizedTweetId(tweet.id) === expected)) {
		throw new Error(`Twitter thread ${tweetId} does not yet include expected reply ${expected}`);
	}
}

export function qualifiesTwitterAuthorThread(thread: readonly Tweet[]): boolean {
	return thread.length > 3;
}

/** Return the canonical root ID only when this is an authored self-reply, never a retweeted reply or comment reply. */
export function twitterSelfReplyRootId(tweet: Tweet): string | null {
	if (tweet.retweetedBy || !isTwitterReply(tweet)) return null;
	const author = normalizedTwitterUserName(tweet.author?.userName);
	const parentAuthor = normalizedTwitterUserName(tweet.inReplyToUsername);
	if (!author || author !== parentAuthor) return null;
	const tweetId = normalizedTweetId(tweet.id);
	const conversationId = normalizedTweetId(tweet.conversationId);
	if (!tweetId || !conversationId || tweetId === conversationId || !/^\d+$/.test(conversationId)) return null;
	return conversationId;
}

function tweetTimestamp(tweet: Tweet): number {
	const timestamp = new Date(tweet.createdAt).getTime();
	return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

/**
 * Retain only tweets that could belong to the root author's reply graph. This
 * is safe before all pages arrive: a child may precede its parent, so graph
 * connectivity is deliberately resolved only after pagination completes.
 */
export function twitterAuthorThreadCandidates(root: Tweet, contextTweets: Tweet[]): Tweet[] {
	const rootId = normalizedTweetId(root.id);
	const rootAuthor = normalizedTwitterUserName(root.author?.userName);
	if (!rootId || !rootAuthor) return [];

	const rootConversationId = normalizedTweetId(root.conversationId) ?? rootId;
	const candidates = new Map<string, Tweet>();
	const seenUrls = new Set([root.url]);
	for (const candidate of contextTweets) {
		const candidateId = normalizedTweetId(candidate.id);
		if (!candidateId || candidateId === rootId || candidates.has(candidateId) || seenUrls.has(candidate.url)) continue;
		if (normalizedTwitterUserName(candidate.author?.userName) !== rootAuthor) continue;
		const candidateConversationId = normalizedTweetId(candidate.conversationId);
		if (candidateConversationId && candidateConversationId !== rootConversationId) continue;
		candidates.set(candidateId, candidate);
		seenUrls.add(candidate.url);
	}
	return [...candidates.values()];
}

/** Build only the root's same-author reply graph; author replies to outside comments are excluded. */
export function buildTwitterAuthorThread(root: Tweet, contextTweets: Tweet[]): Tweet[] {
	const rootId = normalizedTweetId(root.id);
	if (!rootId || !normalizedTwitterUserName(root.author?.userName)) return [root];

	const remaining = new Map<string, Tweet>();
	for (const candidate of twitterAuthorThreadCandidates(root, contextTweets)) {
		const candidateId = normalizedTweetId(candidate.id);
		if (candidateId) remaining.set(candidateId, candidate);
	}

	const ordered = [root];
	const includedIds = new Set([rootId]);
	while (remaining.size) {
		const next = [...remaining.entries()]
			.filter(([, candidate]) => {
				const parentId = normalizedTweetId(candidate.inReplyToId);
				return parentId !== null && includedIds.has(parentId);
			})
			.sort(([, left], [, right]) => tweetTimestamp(left) - tweetTimestamp(right) || (left.id ?? '').localeCompare(right.id ?? ''));
		if (!next.length) break;
		for (const [candidateId, candidate] of next) {
			ordered.push(candidate);
			includedIds.add(candidateId);
			remaining.delete(candidateId);
		}
	}
	return ordered;
}
