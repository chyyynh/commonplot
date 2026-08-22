import assert from 'node:assert/strict';
import { materializeAcquiredResource, resolvedSubjectInput } from '../src/ingest/resource-resolver.ts';
import { detectResourceUrl } from '../src/shared/url.ts';

const base = {
	url: 'https://example.com/article',
	resourceIdentifiers: [],
};

function materialize(input = {}) {
	const url = input.url === undefined ? base.url : input.url;
	const platformIdentity = url ? detectResourceUrl(url) : null;
	return materializeAcquiredResource(
		{
			resourcePlatform: platformIdentity?.resourcePlatform ?? null,
			...(platformIdentity ? { platformId: platformIdentity.platformId } : {}),
			...(url ? { canonicalUrl: url } : {}),
			fileType: null,
			title: 'Example',
			markdown: 'Example content',
			source: 'Example',
			originalLang: 'en',
			publishedDate: null,
			summary: null,
			creators: [],
			kindMetadata: null,
			sourceSnapshotHash: 'a'.repeat(64),
		},
		{
			keywords: [],
			normalizedUrl: url,
			originalLang: 'en',
			processingId: 'processing-id',
			publishedDate: null,
			scope: 'corpus',
			sourceId: null,
			storageKey: null,
			summary: null,
			tags: [],
			url: url ?? 'https://openalex.org/W2',
		},
		{
			canonicalUrl: url,
			platformIdentity,
			publishedDate: null,
			resourceIdentifiers: input.resourceIdentifiers ?? [],
		},
	);
}

const cases = [
	{
		name: 'generic blog',
		input: {},
		expected: { kind: 'blog', resourcePlatform: null, resourceIdentifiers: [] },
	},
	{
		name: 'exact DOI URL',
		input: {
			url: 'https://doi.org/10.1000/example',
			resourceIdentifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
		expected: {
			kind: 'paper',
			resourcePlatform: null,
			resourceIdentifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
	},
	{
		name: 'Citoid academic URL',
		input: {
			resourceIdentifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
		expected: {
			kind: 'paper',
			resourcePlatform: null,
			resourceIdentifiers: [
				{ preferred: true, scheme: 'doi', value: '10.1000/example' },
				{ preferred: true, scheme: 'openalex', value: 'W1' },
			],
		},
	},
	{
		name: 'HN carrier with legacy academic identifiers stays forum',
		input: {
			url: 'https://news.ycombinator.com/item?id=123',
			resourceIdentifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/example' }],
		},
		expected: {
			kind: 'forum',
			resourcePlatform: 'hackernews',
			resourceIdentifiers: [{ preferred: true, scheme: 'hackernews', value: '123' }],
		},
	},
	{
		name: 'HN URL stays forum',
		input: {
			url: 'https://news.ycombinator.com/item?id=124',
		},
		expected: {
			kind: 'forum',
			resourcePlatform: 'hackernews',
			resourceIdentifiers: [{ preferred: true, scheme: 'hackernews', value: '124' }],
		},
	},
	{
		name: 'Twitter share stays post',
		input: {
			url: 'https://x.com/example/status/125',
		},
		expected: {
			kind: 'post',
			resourcePlatform: 'twitter',
			resourceIdentifiers: [{ preferred: true, scheme: 'twitter', value: '125' }],
		},
	},
	{
		name: 'YouTube stays video',
		input: {
			url: 'https://www.youtube.com/watch?v=abcdefghijk',
		},
		expected: {
			kind: 'video',
			resourcePlatform: 'youtube',
			resourceIdentifiers: [{ preferred: true, scheme: 'youtube', value: 'abcdefghijk' }],
		},
	},
	{
		name: 'LessWrong stays a platform blog',
		input: {
			url: 'https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug',
		},
		expected: {
			kind: 'blog',
			resourcePlatform: 'lesswrong',
			resourceIdentifiers: [{ preferred: true, scheme: 'lesswrong', value: 'A2kJKqnHhh5Hq4p2S' }],
		},
	},
	{
		name: 'OpenAlex-resolved paper',
		input: {
			url: null,
			resourceIdentifiers: [{ preferred: true, scheme: 'openalex', value: 'W2' }],
		},
		expected: {
			kind: 'paper',
			resourcePlatform: null,
			resourceIdentifiers: [{ preferred: true, scheme: 'openalex', value: 'W2' }],
		},
	},
];

for (const testCase of cases) {
	const actual = materialize(testCase.input);
	assert.deepEqual(Object.fromEntries(Object.keys(testCase.expected).map((key) => [key, actual[key]])), testCase.expected, testCase.name);
}

const migratedCarrier = materialize({
	url: 'https://news.ycombinator.com/item?id=126',
	resourceIdentifiers: [
		{ preferred: true, scheme: 'doi', value: '10.1000/example' },
		{ preferred: true, scheme: 'openalex', value: 'W1' },
	],
});
assert.deepEqual(
	migratedCarrier.resourceIdentifiers,
	[{ preferred: true, scheme: 'hackernews', value: '126' }],
	'carrier identity drops legacy academic identifiers',
);

assert.deepEqual(
	resolvedSubjectInput('https://doi.org/10.1000/example'),
	{
		identifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/example' }],
		normalizedUrl: 'https://doi.org/10.1000/example',
		url: 'https://doi.org/10.1000/example',
	},
	'paper subjects resolve independently from their carrier',
);

assert.deepEqual(
	resolvedSubjectInput('https://example.com/article'),
	{
		identifiers: [],
		normalizedUrl: 'https://example.com/article',
		url: 'https://example.com/article',
	},
	'generic subjects retain their normalized URL identity',
);

console.info(`Resource resolver contract checks passed (${cases.length + 2} cases).`);
