import assert from 'node:assert/strict';
import {
	nextTwitterSearchWindow,
	parseTwitterAdvancedSearchPage,
	parseTwitterArticleResponse,
	parseTwitterTweetsResponse,
	renderTwitterArticleMarkdown,
	twitterSearchNeedsOlderWindow,
	twitterSearchWindow,
	withTwitterSearchWindow,
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

const searchWindow = twitterSearchWindow('2026-08-21T12:00:00.000Z', new Date('2026-08-21T18:00:00.000Z'), 60 * 60 * 1000);
assert.deepEqual(searchWindow, { sinceTime: 1_787_310_000, untilTime: 1_787_335_200 });
assert.equal(
	withTwitterSearchWindow('from:openai -filter:replies', searchWindow),
	'from:openai -filter:replies since_time:1787310000 until_time:1787335200',
);
assert.deepEqual(
	nextTwitterSearchWindow({ sinceTime: 100, untilTime: 200 }, [{ ...tweet, createdAt: '1970-01-01T00:02:30.000Z' }], 'Twitter test search'),
	{ sinceTime: 100, untilTime: 151 },
);
assert.throws(() => nextTwitterSearchWindow({ sinceTime: 100, untilTime: 200 }, [], 'Twitter test search'), /empty result/);
assert.equal(twitterSearchNeedsOlderWindow({ rawTweetCount: 20, hasNextPage: false }), true);
assert.equal(twitterSearchNeedsOlderWindow({ rawTweetCount: 1, hasNextPage: true }), true);
assert.equal(twitterSearchNeedsOlderWindow({ rawTweetCount: 1, hasNextPage: false }), false);

assert.deepEqual(parseTwitterAdvancedSearchPage({ tweets: [tweet], has_next_page: false, next_cursor: null }), {
	tweets: [tweet],
	rawTweetCount: 1,
	invalidItems: [],
	hasNextPage: false,
});
const saturatedSearchPage = parseTwitterAdvancedSearchPage({
	tweets: [{ ...tweet, createdAt: 123 }, ...Array.from({ length: 19 }, () => tweet)],
	has_next_page: false,
});
assert.equal(saturatedSearchPage.rawTweetCount, 20);
assert.equal(saturatedSearchPage.tweets.length, 19);
assert.equal(saturatedSearchPage.invalidItems[0]?.index, 0);
assert.equal(twitterSearchNeedsOlderWindow(saturatedSearchPage), true);
assert.throws(
	() => parseTwitterAdvancedSearchPage({ tweets: [], has_next_page: false, status: 'error', message: 'search failed' }),
	/search failed/,
);

console.info({
	event: 'twitter_provider_contract_passed',
	articleCases: 3,
	advancedSearchCases: 8,
	responseShapeCases: 4,
	searchWindowCases: 7,
});
