import assert from 'node:assert/strict';
import { materializeGenericResource, materializePlatformResource } from '../src/ingest/platforms/materialize.ts';
import { detectResourceUrl } from '../src/shared/url.ts';

const base = {
	url: 'https://example.com/article',
};

function materialize(input = {}) {
	const url = input.url === undefined ? base.url : input.url;
	const platformIdentity = url ? detectResourceUrl(url) : null;
	const acquired = {
		...(url ? { canonicalUrl: url } : {}),
		...(input.subjectUrl ? { subjectUrl: input.subjectUrl } : {}),
		fileType: null,
		title: 'Example',
		markdown: 'Example content',
		source: 'Example',
		originalLang: 'en',
		publishedDate: null,
		summary: null,
		creators: [],
		kindMetadata: null,
	};
	const hints = { originalLang: 'en', publishedDate: null, summary: null };
	if (platformIdentity) {
		return materializePlatformResource(
			{ ...acquired, platformId: platformIdentity.platformId, resourcePlatform: platformIdentity.resourcePlatform },
			hints,
			{ kind: input.kind, url },
		);
	}
	const identity =
		input.kind === 'paper'
			? { kind: 'paper', resourceIdentifiers: input.resourceIdentifiers ?? [] }
			: { kind: 'blog', resourceIdentifiers: [] };
	return materializeGenericResource({ ...acquired, resourcePlatform: null }, hints, {
		canonicalUrl: url,
		identity,
		publishedDate: null,
	});
}

const cases = [
	{
		name: 'generic blog',
		input: {},
		expected: { kind: 'blog', resourcePlatform: null, resourceIdentifiers: [] },
	},
	{
		name: 'resolved paper keeps its DOI URL',
		input: {
			kind: 'paper',
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
		name: 'resolved paper keeps provider identifiers',
		input: {
			kind: 'paper',
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
			kind: 'forum',
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
			kind: 'forum',
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
			kind: 'post',
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
			kind: 'video',
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
			kind: 'blog',
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
			kind: 'paper',
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
	kind: 'forum',
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
	materialize({ subjectUrl: 'https://doi.org/10.1000/example' }).subject,
	{
		identifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/example' }],
		normalizedUrl: 'https://doi.org/10.1000/example',
	},
	'paper subjects resolve independently from their carrier',
);

assert.deepEqual(
	materialize({ subjectUrl: 'https://example.com/article' }).subject,
	{
		identifiers: [],
		normalizedUrl: 'https://example.com/article',
	},
	'generic subjects retain their normalized URL identity',
);

console.info(`Platform materialization contract checks passed (${cases.length + 2} cases).`);
