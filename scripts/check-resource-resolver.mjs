import assert from 'node:assert/strict';
import { resolveContentResource, resolvedResourceIdentifiers } from '../src/ingest/resource-resolver.ts';

const base = {
	url: 'https://example.com/article',
	paperIdentifiers: [],
	resourceIdentifiers: [],
};

const cases = [
	{
		name: 'generic blog',
		input: {},
		expected: { kind: 'blog', resourcePlatform: null },
	},
	{
		name: 'exact DOI URL',
		input: {
			url: 'https://doi.org/10.1000/example',
			paperIdentifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
		expected: { kind: 'paper', resourcePlatform: null },
	},
	{
		name: 'Citoid academic URL',
		input: {
			paperIdentifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
		expected: { kind: 'paper', resourcePlatform: null },
	},
	{
		name: 'HN carrier with academic subject stays forum',
		input: {
			url: 'https://news.ycombinator.com/item?id=123',
			paperIdentifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/example' }],
			subjectUrl: 'https://doi.org/10.1000/example',
		},
		expected: { kind: 'forum', resourcePlatform: 'hackernews', locator: { itemId: '123' } },
	},
	{
		name: 'HN carrier with blog subject stays forum',
		input: {
			url: 'https://news.ycombinator.com/item?id=124',
			subjectUrl: 'https://example.com/article',
		},
		expected: { kind: 'forum', resourcePlatform: 'hackernews', locator: { itemId: '124' } },
	},
	{
		name: 'stored HN locator repairs a legacy external root URL',
		input: {
			resourceIdentifiers: [{ preferred: true, scheme: 'hackernews', value: '127' }],
			subjectUrl: 'https://example.com/article',
		},
		expected: { kind: 'forum', resourcePlatform: 'hackernews', locator: { itemId: '127' } },
	},
	{
		name: 'Twitter share stays post',
		input: {
			url: 'https://x.com/example/status/125',
			subjectUrl: 'https://example.com/article',
		},
		expected: { kind: 'post', resourcePlatform: 'twitter', locator: { tweetId: '125' } },
	},
	{
		name: 'YouTube stays video',
		input: {
			url: 'https://www.youtube.com/watch?v=abcdefghijk',
		},
		expected: { kind: 'video', resourcePlatform: 'youtube', locator: { videoId: 'abcdefghijk' } },
	},
	{
		name: 'OpenAlex-resolved paper',
		input: {
			url: null,
			paperIdentifiers: [{ preferred: true, scheme: 'openalex', value: 'W2' }],
		},
		expected: { kind: 'paper', resourcePlatform: null },
	},
];

for (const testCase of cases) {
	const actual = resolveContentResource({ ...base, ...testCase.input });
	assert.deepEqual(Object.fromEntries(Object.keys(testCase.expected).map((key) => [key, actual[key]])), testCase.expected, testCase.name);
}

const migratedCarrier = resolveContentResource({
	...base,
	url: 'https://news.ycombinator.com/item?id=126',
	subjectUrl: 'https://doi.org/10.1000/example',
});
assert.deepEqual(
	resolvedResourceIdentifiers(migratedCarrier, [
		{ preferred: true, scheme: 'doi', value: '10.1000/example' },
		{ preferred: true, scheme: 'openalex', value: 'W1' },
	]),
	[{ preferred: true, scheme: 'hackernews', value: '126' }],
	'carrier identity drops legacy academic identifiers',
);

console.info(`Resource resolver contract checks passed (${cases.length} cases).`);
