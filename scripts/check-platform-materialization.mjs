import assert from 'node:assert/strict';
import { materializeGenericResource, materializePlatformResource } from '../src/ingest/platforms/materialize.ts';
import {
	hostedResourceImageFields,
	normalizedExternalMediaUrl,
	normalizedResourceImageUrl,
	resourceImageSourceUrls,
} from '../src/shared/image-mapping.ts';

const base = {
	url: 'https://example.com/article',
};

function materialize(input = {}) {
	const url = input.url === undefined ? base.url : input.url;
	const acquired = {
		...(url ? { canonicalUrl: url } : {}),
		fileType: input.fileType ?? null,
		title: 'Example',
		markdown: 'Example content',
		source: 'Example',
		originalLang: 'en',
		publishedDate: input.publishedDate ?? null,
		summary: null,
		creators: [],
		kindMetadata: input.kindMetadata ?? null,
	};
	const hints = { originalLang: 'en', publishedDate: null, summary: null };
	if (input.resourcePlatform) {
		return materializePlatformResource(
			{ ...acquired, platformId: input.platformId, resourcePlatform: input.resourcePlatform },
			hints,
			{ kind: input.kind, url },
			input.subject ?? null,
		);
	}
	return materializeGenericResource({ ...acquired, resourcePlatform: null }, hints, {
		canonicalUrl: url,
		publishedDate: null,
		resourceIdentifiers: input.resourceIdentifiers ?? [],
	});
}

const cases = [
	{
		name: 'generic blog',
		input: {},
		expected: { kind: 'blog', resourcePlatform: null, resourceIdentifiers: [] },
	},
	{
		name: 'unresolved PDF remains a readable PDF file',
		input: {
			fileType: 'application/pdf',
			kindMetadata: { siteName: 'example.com' },
			resourceIdentifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/unresolved' }],
		},
		expected: {
			kind: 'file',
			resourcePlatform: null,
			resourceIdentifiers: [],
			fileType: 'application/pdf',
			content: 'Example content',
			kindMetadata: null,
		},
	},
	{
		name: 'resolved paper keeps its DOI URL',
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
		name: 'resolved paper keeps provider identifiers',
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
			kind: 'forum',
			platformId: '123',
			resourcePlatform: 'hackernews',
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
			platformId: '124',
			resourcePlatform: 'hackernews',
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
			platformId: '125',
			resourcePlatform: 'twitter',
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
			platformId: 'abcdefghijk',
			resourcePlatform: 'youtube',
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
			platformId: 'A2kJKqnHhh5Hq4p2S',
			resourcePlatform: 'lesswrong',
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
	kind: 'forum',
	platformId: '126',
	resourcePlatform: 'hackernews',
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

const paperSubject = {
	identifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/example' }],
	normalizedUrl: 'https://doi.org/10.1000/example',
};

assert.deepEqual(
	materialize({
		kind: 'forum',
		platformId: '127',
		resourcePlatform: 'hackernews',
		url: 'https://news.ycombinator.com/item?id=127',
		subject: paperSubject,
	}).subject,
	{ ...paperSubject, publishedDate: null },
	'materialization keeps the already-resolved paper subject',
);

// A subject page routinely publishes no date of its own; the carrier's date
// travels with it so the subject can still be placed chronologically.
assert.deepEqual(
	materialize({
		kind: 'forum',
		platformId: '128',
		resourcePlatform: 'hackernews',
		publishedDate: '2026-08-29T14:02:10.000Z',
		url: 'https://news.ycombinator.com/item?id=128',
		subject: paperSubject,
	}).subject,
	{ ...paperSubject, publishedDate: '2026-08-29T14:02:10.000Z' },
	'subject inherits the carrier publication date',
);

const imageA = 'https://images.example.com/a.jpg';
const imageB = 'https://images.example.com/b.jpg';
const avatar = 'https://avatars.example.com/author.jpg';
const imageInput = {
	creators: [{ avatarUrl: avatar, literal: 'Author', role: 'author' }],
	kindMetadata: {
		attachments: [
			{ kind: 'image', url: imageA },
			{ kind: 'image', url: imageB },
		],
	},
	ogImageUrl: imageB,
};
assert.deepEqual(resourceImageSourceUrls(imageInput), [imageA, imageB, avatar]);
assert.equal(normalizedExternalMediaUrl('https://user:password@images.example.com/private.png'), null);
assert.equal(
	normalizedResourceImageUrl('/wp-content/uploads/preview.jpg?resize=150,150&crop=1', 'https://example.com/article'),
	'https://example.com/wp-content/uploads/preview.jpg?w=1200',
);
const hosted = [
	{ deliveryUrl: `https://imagedelivery.net/account/resource-${'a'.repeat(64)}/public`, sourceUrl: imageA },
	{ deliveryUrl: `https://imagedelivery.net/account/resource-${'b'.repeat(64)}/public`, sourceUrl: imageB },
	{ deliveryUrl: `https://imagedelivery.net/account/resource-${'c'.repeat(64)}/public`, sourceUrl: avatar },
];
const canonicalImages = hostedResourceImageFields(imageInput, hosted);
assert.deepEqual(
	resourceImageSourceUrls(canonicalImages),
	hosted.map(({ deliveryUrl }) => deliveryUrl),
);
assert.throws(() => hostedResourceImageFields(imageInput, hosted.slice(0, 1)), /do not cover every source/);

console.info(`Platform materialization contract checks passed (${cases.length + 7} cases).`);
