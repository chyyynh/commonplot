import assert from 'node:assert/strict';
import {
	parseTwitterAdvancedSearchPage,
	parseTwitterArticleResponse,
	parseTwitterTweetsResponse,
	renderTwitterArticleMarkdown,
} from '../src/ingest/platforms/twitter-data.ts';

const tweet = {
	id: '1',
	url: 'https://x.com/openai/status/1',
	createdAt: '2026-08-21T00:00:01Z',
	author: { userName: 'openai', name: 'OpenAI' },
	text: 'Example post',
};

assert.throws(() => parseTwitterTweetsResponse({ tweets: [], status: 'error', message: 'tweet failed' }), /tweet failed/);
const [parsedTweet] = parseTwitterTweetsResponse({
	tweets: [{ ...tweet, bookmarkCount: 99, viewCount: 100, author: { ...tweet.author, followers: 1_000_000 } }],
});
assert.equal('bookmarkCount' in parsedTweet, false);
assert.equal('viewCount' in parsedTweet, false);
assert.equal('followers' in parsedTweet.author, false);

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
				{ type: 'image', url: 'https://example.com/image.jpg' },
			],
		},
	},
	'1',
);
assert.equal(renderTwitterArticleMarkdown(article), '# Heading\n\n**Bold** text\n\n- One\n- Two\n\n![](https://example.com/image.jpg)');
assert.throws(() => parseTwitterArticleResponse({ status: 'failed', message: 'article failed' }, '1'), /article failed/);

assert.deepEqual(parseTwitterAdvancedSearchPage({ tweets: [tweet], has_next_page: false, next_cursor: null }), {
	tweets: [tweet],
	rawTweetCount: 1,
	invalidItems: [],
	hasNextPage: false,
	nextCursor: null,
});
const saturatedSearchPage = parseTwitterAdvancedSearchPage({
	tweets: [{ ...tweet, createdAt: 123 }, ...Array.from({ length: 19 }, () => tweet)],
	has_next_page: true,
	next_cursor: 'next-page',
});
assert.equal(saturatedSearchPage.rawTweetCount, 20);
assert.equal(saturatedSearchPage.tweets.length, 19);
assert.equal(saturatedSearchPage.invalidItems[0]?.index, 0);
assert.equal(saturatedSearchPage.nextCursor, 'next-page');
const [tweetWithInvalidQuote] = parseTwitterAdvancedSearchPage({
	tweets: [{ ...tweet, quoted_tweet: { ...tweet, createdAt: 123 } }],
	has_next_page: false,
	next_cursor: '',
}).tweets;
assert.equal(tweetWithInvalidQuote.quoted_tweet, null);
const [tweetWithInvalidRetweet] = parseTwitterAdvancedSearchPage({
	tweets: [{ ...tweet, text: 'RT @example Example post', retweeted_tweet: { ...tweet, createdAt: 123 } }],
	has_next_page: false,
	next_cursor: null,
}).tweets;
assert.equal(tweetWithInvalidRetweet.retweeted_tweet, null);
assert.throws(
	() => parseTwitterAdvancedSearchPage({ tweets: [], has_next_page: false, status: 'error', message: 'search failed' }),
	/search failed/,
);

console.info({
	event: 'twitter_provider_contract_passed',
	articleCases: 3,
	advancedSearchCases: 7,
	responseShapeCases: 4,
});
