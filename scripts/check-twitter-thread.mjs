import assert from 'node:assert/strict';
import {
	buildTwitterAuthorThread,
	isTwitterReply,
	parseTwitterThreadContextPage,
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

console.info({
	event: 'twitter_thread_smoke_passed',
	threadGraphCases: 1,
	replyPredicateCases: 5,
	selfReplyRootCases: 4,
	responseShapeCases: 3,
});
