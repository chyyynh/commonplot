import assert from 'node:assert/strict';
import {
	buildTwitterAdvancedSearchQuery,
	buildTwitterAuthorThread,
	combineTwitterThreadMarkdown,
	decideTwitterThreadContextNextPage,
	isTwitterReply,
	parseTwitterAdvancedSearchPage,
	parseTwitterArticleResponse,
	parseTwitterThreadContextPage,
	parseTwitterTweetsResponse,
	renderTwitterArticleMarkdown,
	twitterAuthorThreadCandidates,
	twitterSearchWindow,
	twitterSelfReplyRootId,
} from '../src/ingest/platforms/twitter-data.ts';

function tweet(id, author, inReplyToId, overrides = {}) {
	return {
		id,
		url: `https://x.com/${author}/status/${id}`,
		createdAt: `2026-08-21T00:00:0${id}Z`,
		author: { userName: author, name: author },
		text: `post-${id}`,
		conversationId: '1',
		...(inReplyToId === null ? {} : { inReplyToId }),
		...overrides,
	};
}

const root = tweet('1', 'Alice', null);
const selfReply = tweet('2', 'alice', '1');
const outsideComment = tweet('3', 'Bob', '1');
const authorReplyToComment = tweet('4', 'ALICE', '3');
const continuedThread = tweet('5', 'Alice', '2');

assert.deepEqual(
	buildTwitterAuthorThread(root, [authorReplyToComment, continuedThread, outsideComment, selfReply, selfReply]).map((item) => item.id),
	['1', '2', '5'],
);
assert.deepEqual(
	twitterAuthorThreadCandidates(root, [authorReplyToComment, continuedThread, outsideComment, selfReply, selfReply]).map((item) => item.id),
	['4', '5', '2'],
);

assert.equal(isTwitterReply(tweet('6', 'Alice', null, { isReply: true })), true);
assert.equal(isTwitterReply(tweet('7', 'Alice', '1')), true);
assert.equal(isTwitterReply(tweet('8', 'Alice', null, { inReplyToUsername: 'Bob' })), true);
assert.equal(isTwitterReply(tweet('9', 'Alice', null, { conversationId: '1' })), true);
assert.equal(isTwitterReply(tweet('10', 'Alice', null, { conversationId: '10' })), false);

assert.equal(twitterSelfReplyRootId(tweet('11', 'Alice', '1', { inReplyToUsername: 'alice' })), '1');
assert.equal(twitterSelfReplyRootId(tweet('12', 'Alice', '1', { inReplyToUsername: 'Bob' })), null);
assert.equal(twitterSelfReplyRootId(tweet('13', 'Alice', '1', { inReplyToUsername: null })), null);
assert.equal(
	twitterSelfReplyRootId(
		tweet('14', 'Alice', '1', {
			inReplyToUsername: 'Alice',
			retweetedBy: { authorName: 'Carol', authorUserName: 'Carol' },
		}),
	),
	null,
);

assert.deepEqual(parseTwitterThreadContextPage({ tweets: [root], has_next_page: false }, '1').tweets, [root]);
assert.deepEqual(parseTwitterThreadContextPage({ replies: [selfReply], has_next_page: false }, '1').tweets, [selfReply]);
assert.throws(
	() => parseTwitterThreadContextPage({ status: 'error', message: 'provider failed', replies: [], has_next_page: false }, '1'),
	/provider failed/,
);
assert.deepEqual(decideTwitterThreadContextNextPage({ tweets: [], hasNextPage: true }, new Set(), '1'), { kind: 'empty-page' });
assert.deepEqual(decideTwitterThreadContextNextPage({ tweets: [selfReply], hasNextPage: false }, new Set(), '1'), { kind: 'complete' });
assert.deepEqual(decideTwitterThreadContextNextPage({ tweets: [selfReply], hasNextPage: true, nextCursor: ' next ' }, new Set(), '1'), {
	kind: 'next',
	cursor: 'next',
});
assert.throws(() => decideTwitterThreadContextNextPage({ tweets: [selfReply], hasNextPage: true }, new Set(), '1'), /next cursor/);
assert.throws(
	() => decideTwitterThreadContextNextPage({ tweets: [selfReply], hasNextPage: true, nextCursor: 'repeat' }, new Set(['repeat']), '1'),
	/repeated cursor/,
);
assert.throws(() => parseTwitterTweetsResponse({ tweets: [], status: 'error', message: 'tweet failed' }), /tweet failed/);

const article = parseTwitterArticleResponse(
	{
		status: 'success',
		article: {
			title: 'Article title',
			contents: [
				{ type: 'header-one', text: 'Heading' },
				{ type: 'unstyled', text: 'Bold text', inlineStyleRanges: [{ offset: 0, length: 4, style: 'Bold' }] },
				{ type: 'unordered-list-item', text: 'One' },
				{ type: 'unordered-list-item', text: 'Two' },
				{ type: 'ordered-list-item', text: 'First' },
				{ type: 'ordered-list-item', text: 'Second' },
				{ type: 'image', url: 'https://example.com/image.jpg' },
				{ type: 'gif', previewUrl: 'https://example.com/preview.jpg', url: 'https://example.com/animation.mp4' },
				{ type: 'divider' },
				{ type: 'markdown', text: '**raw**' },
			],
		},
	},
	'1',
);
assert.equal(
	renderTwitterArticleMarkdown(article),
	'# Heading\n\n**Bold** text\n\n- One\n- Two\n\n1. First\n1. Second\n\n![](https://example.com/image.jpg)\n\n![GIF](https://example.com/preview.jpg)\n\n[GIF](https://example.com/animation.mp4)\n\n---\n\n**raw**',
);
assert.throws(() => parseTwitterArticleResponse({ status: 'failed', message: 'article failed' }, '1'), /article failed/);
assert.equal(
	combineTwitterThreadMarkdown('Article body', ['Continuation one', '', 'Continuation two']),
	'Article body\n\nContinuation one\n\nContinuation two',
);

const searchWindow = twitterSearchWindow('2026-08-21T12:00:00.000Z', new Date('2026-08-21T18:00:00.000Z'), 60 * 60 * 1000);
assert.deepEqual(searchWindow, { sinceTime: 1_787_310_000, untilTime: 1_787_335_200 });
assert.equal(buildTwitterAdvancedSearchQuery('@OpenAI', searchWindow), 'from:openai since_time:1787310000 until_time:1787335200');
assert.throws(() => twitterSearchWindow('2026-08-21T19:00:00.000Z', new Date('2026-08-21T18:00:00.000Z'), 0), /empty or invalid/);
assert.deepEqual(parseTwitterAdvancedSearchPage({ tweets: [root], has_next_page: true, next_cursor: 'next' }), {
	tweets: [root],
	hasNextPage: true,
	nextCursor: 'next',
});

console.info({
	event: 'twitter_thread_smoke_passed',
	articleCases: 3,
	advancedSearchCases: 4,
	threadGraphCases: 2,
	threadPaginationCases: 5,
	replyPredicateCases: 5,
	selfReplyRootCases: 4,
	responseShapeCases: 4,
});
