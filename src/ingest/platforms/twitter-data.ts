import { z } from 'zod';

const TwitterAuthorSchema = z.looseObject({
	id: z.string().optional(),
	userName: z.string(),
	name: z.string(),
	profilePicture: z.string().optional(),
	isBlueVerified: z.boolean().optional(),
});

const TwitterUrlEntitySchema = z.looseObject({
	expanded_url: z.string().optional(),
	url: z.string().optional(),
});

const TwitterMediaEntitySchema = z.looseObject({
	media_url_https: z.string(),
	type: z.string(),
	sizes: z
		.looseObject({
			large: z.looseObject({ w: z.number(), h: z.number() }).optional(),
		})
		.optional(),
	video_info: z
		.looseObject({
			variants: z
				.array(
					z.looseObject({
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
	tweetId?: string;
	tweetUrl?: string;
	retweetedAt?: string;
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

// twitterapi.io tweet response shape used inside the Twitter platform only.
export interface Tweet {
	id?: string;
	url: string;
	createdAt: string;
	viewCount?: number;
	author?: {
		id?: string;
		userName: string;
		name: string;
		profilePicture?: string;
		isBlueVerified?: boolean;
	};
	text: string;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
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

const RetweetedByDataSchema = z.looseObject({
	tweetId: z.string().optional(),
	tweetUrl: z.string().optional(),
	retweetedAt: z.string().optional(),
	authorName: z.string(),
	authorUserName: z.string(),
	authorProfilePicture: z.string().optional(),
	authorVerified: z.boolean().optional(),
});

const TweetSchema: z.ZodType<Tweet> = z.lazy(() =>
	z.looseObject({
		id: z.string().optional(),
		url: z.string().min(1),
		createdAt: z.string().min(1),
		viewCount: z.number().optional(),
		author: TwitterAuthorSchema.optional(),
		text: z.string(),
		likeCount: z.number().optional(),
		retweetCount: z.number().optional(),
		replyCount: z.number().optional(),
		quoteCount: z.number().optional(),
		extendedEntities: z.looseObject({ media: z.array(TwitterMediaEntitySchema).optional() }).optional(),
		hashTags: z.array(z.string()).optional(),
		urls: z.array(TwitterUrlEntitySchema).optional(),
		entities: z.looseObject({ urls: z.array(TwitterUrlEntitySchema).optional() }).optional(),
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

const TwitterTweetsResponseSchema = z.looseObject({
	tweets: z.array(TweetSchema),
	status: z.string().optional(),
	msg: z.string().optional(),
});

const TwitterListPageSchema = z.looseObject({
	tweets: z.array(TweetSchema),
	has_next_page: z.boolean(),
	next_cursor: z.string().optional(),
});

const TwitterThreadContextPageSchema = z.looseObject({
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

function semanticTwitterError(status: string | undefined, message: string | undefined): string | null {
	return status?.toLowerCase() === 'error' ? message?.trim() || 'unknown provider error' : null;
}

export function parseTwitterTweetsResponse(value: unknown): Tweet[] {
	const response = TwitterTweetsResponseSchema.parse(value);
	const error = semanticTwitterError(response.status, response.msg);
	if (error) throw new Error(`Twitter tweets request failed: ${error}`);
	return response.tweets;
}

export function parseTwitterAdvancedSearchPage(value: unknown): TwitterListPage {
	const response = TwitterListPageSchema.parse(value);
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

function tweetTimestamp(tweet: Tweet): number {
	const timestamp = new Date(tweet.createdAt).getTime();
	return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

/** Build only the root's same-author reply graph; author replies to outside comments are excluded. */
export function buildTwitterAuthorThread(root: Tweet, contextTweets: Tweet[]): Tweet[] {
	const rootId = normalizedTweetId(root.id);
	const rootAuthor = normalizedTwitterUserName(root.author?.userName);
	if (!rootId || !rootAuthor) return [root];

	const rootConversationId = normalizedTweetId(root.conversationId) ?? rootId;
	const remaining = new Map<string, Tweet>();
	const seenUrls = new Set([root.url]);
	for (const candidate of contextTweets) {
		const candidateId = normalizedTweetId(candidate.id);
		if (!candidateId || candidateId === rootId || remaining.has(candidateId) || seenUrls.has(candidate.url)) continue;
		if (normalizedTwitterUserName(candidate.author?.userName) !== rootAuthor) continue;
		const candidateConversationId = normalizedTweetId(candidate.conversationId);
		if (candidateConversationId && candidateConversationId !== rootConversationId) continue;
		remaining.set(candidateId, candidate);
		seenUrls.add(candidate.url);
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
