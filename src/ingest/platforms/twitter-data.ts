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

const RetweetedByDataSchema = z.object({
	authorUserName: z.string(),
});

const TweetSchema = z.object({
	id: z.string().optional(),
	url: z.string().min(1),
	createdAt: z.string().min(1),
	author: TwitterAuthorSchema.optional(),
	text: z.string(),
	extendedEntities: z.object({ media: z.array(TwitterMediaEntitySchema).optional() }).optional(),
	hashTags: z.array(z.string().max(500)).max(100).optional(),
	urls: z.array(TwitterUrlEntitySchema).optional(),
	entities: z.object({ urls: z.array(TwitterUrlEntitySchema).optional() }).optional(),
	lang: z.string().max(35).optional(),
	get quoted_tweet(): z.ZodCatch<z.ZodOptional<z.ZodNullable<typeof TweetSchema>>> {
		return TweetSchema.nullish().catch(null);
	},
	get retweeted_tweet(): z.ZodCatch<z.ZodOptional<z.ZodNullable<typeof TweetSchema>>> {
		return TweetSchema.nullish().catch(null);
	},
	retweetedBy: RetweetedByDataSchema.optional(),
});

export type Tweet = z.infer<typeof TweetSchema>;

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
	next_cursor: z.string().nullish(),
	status: z.string().optional(),
	message: z.string().optional(),
	msg: z.string().optional(),
});

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

export function renderTwitterArticleMarkdown(article: TwitterArticle): string {
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

export function parseTwitterAdvancedSearchPage(value: unknown) {
	const response = TwitterAdvancedSearchEnvelopeSchema.parse(value);
	const error = semanticTwitterError(response.status, response.message ?? response.msg);
	if (error) throw new Error(`Twitter Advanced Search failed: ${error}`);
	const tweets: Tweet[] = [];
	const invalidItems: Array<{ index: number; message: string }> = [];
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
		nextCursor: response.next_cursor?.trim() || null,
	};
}
