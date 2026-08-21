import assert from 'node:assert/strict';
import { resolveContentResource, resolvedSubjectInput } from '../src/ingest/resource-resolver.ts';

const base = {
	kind: 'blog',
	resource_platform: null,
	url: 'https://example.com/article',
	normalized_url: 'https://example.com/article',
	resource_identifiers: [],
};

const cases = [
	{
		name: 'generic blog',
		input: {},
		expected: { kind: 'blog', resource_platform: null, resource_identifiers: [] },
	},
	{
		name: 'exact DOI URL',
		input: {
			url: 'https://doi.org/10.1000/example',
			resource_identifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
		expected: {
			kind: 'paper',
			resource_platform: null,
			resource_identifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
	},
	{
		name: 'Citoid academic URL',
		input: {
			resource_identifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
		expected: {
			kind: 'paper',
			resource_platform: null,
			resource_identifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
	},
	{
		name: 'HN carrier with legacy academic identifiers stays forum',
		input: {
			url: 'https://news.ycombinator.com/item?id=123',
			resource_identifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/example' }],
		},
		expected: {
			kind: 'forum',
			resource_platform: 'hackernews',
			resource_identifiers: [{ preferred: true, scheme: 'hackernews', value: '123' }],
		},
	},
	{
		name: 'HN URL stays forum',
		input: {
			url: 'https://news.ycombinator.com/item?id=124',
		},
		expected: {
			kind: 'forum',
			resource_platform: 'hackernews',
			resource_identifiers: [{ preferred: true, scheme: 'hackernews', value: '124' }],
		},
	},
	{
		name: 'Twitter share stays post',
		input: {
			url: 'https://x.com/example/status/125',
		},
		expected: {
			kind: 'post',
			resource_platform: 'twitter',
			resource_identifiers: [{ preferred: true, scheme: 'twitter', value: '125' }],
		},
	},
	{
		name: 'YouTube stays video',
		input: {
			url: 'https://www.youtube.com/watch?v=abcdefghijk',
		},
		expected: {
			kind: 'video',
			resource_platform: 'youtube',
			resource_identifiers: [{ preferred: true, scheme: 'youtube', value: 'abcdefghijk' }],
		},
	},
	{
		name: 'LessWrong stays a platform blog',
		input: {
			url: 'https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug',
		},
		expected: {
			kind: 'blog',
			resource_platform: 'lesswrong',
			resource_identifiers: [{ preferred: true, scheme: 'lesswrong', value: 'A2kJKqnHhh5Hq4p2S' }],
		},
	},
	{
		name: 'OpenAlex-resolved paper',
		input: {
			url: null,
			resource_identifiers: [{ preferred: true, scheme: 'openalex', value: 'W2' }],
		},
		expected: {
			kind: 'paper',
			resource_platform: null,
			resource_identifiers: [{ preferred: true, scheme: 'openalex', value: 'W2' }],
		},
	},
];

for (const testCase of cases) {
	const actual = resolveContentResource({ ...base, ...testCase.input });
	assert.deepEqual(Object.fromEntries(Object.keys(testCase.expected).map((key) => [key, actual[key]])), testCase.expected, testCase.name);
}

const migratedCarrier = resolveContentResource({
	...base,
	url: 'https://news.ycombinator.com/item?id=126',
	resource_identifiers: [
		{ preferred: true, scheme: 'doi', value: '10.1000/example' },
		{ preferred: true, scheme: 'openalex', value: 'W1' },
	],
});
assert.deepEqual(
	migratedCarrier.resource_identifiers,
	[{ preferred: true, scheme: 'hackernews', value: '126' }],
	'carrier identity drops legacy academic identifiers',
);

assert.deepEqual(
	resolvedSubjectInput('https://doi.org/10.1000/example'),
	{
		identifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/example' }],
		normalizedUrl: 'https://doi.org/10.1000/example',
		title: '10.1000/example',
		url: 'https://doi.org/10.1000/example',
	},
	'paper subjects resolve independently from their carrier',
);

assert.deepEqual(
	resolvedSubjectInput('https://example.com/article'),
	{
		identifiers: [],
		normalizedUrl: 'https://example.com/article',
		title: 'example.com',
		url: 'https://example.com/article',
	},
	'generic subjects retain their normalized URL identity',
);

console.info(`Resource resolver contract checks passed (${cases.length + 2} cases).`);
