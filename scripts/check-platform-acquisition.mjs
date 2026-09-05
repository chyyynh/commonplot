import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'cloudflare:workflows')
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		if (specifier === 'youtube-transcript')
			return { shortCircuit: true, url: 'data:text/javascript,export const YoutubeTranscript = { fetchTranscript: async () => [] };' };
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/core-worker/src/')) {
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		}
		return nextResolve(specifier, context);
	},
});

const [
	{ stageHackerNewsAcquisition },
	{ stageLessWrongAcquisition },
	{ stageTwitterAcquisition },
	{ stageYouTubeAcquisition },
	{ stagePaperResolution },
	{ pdfResource },
	{ webResource },
] = await Promise.all([
	import('../src/ingest/platforms/hackernews.ts'),
	import('../src/ingest/platforms/lesswrong.ts'),
	import('../src/ingest/platforms/twitter-acquisition.ts'),
	import('../src/ingest/platforms/youtube.ts'),
	import('../src/ingest/platforms/paper.ts'),
	import('../src/ingest/platforms/pdf.ts'),
	import('../src/ingest/platforms/web.ts'),
]);

import {
	hostedResourceImageFields,
	normalizedExternalMediaUrl,
	normalizedResourceImageUrl,
	resourceImageSourceUrls,
} from '../src/shared/image-mapping.ts';

const { YoutubeTranscript } = await import('youtube-transcript');

const base = {
	url: 'https://example.com/article',
};

async function acquire(input = {}) {
	const url = input.url === undefined ? base.url : input.url;
	const acquired = {
		...(url ? { canonicalUrl: url } : {}),
		fileType: input.fileType ?? null,
		title: 'Example',
		markdown: 'Example content',
		source: 'Example',
		originalLang: input.originalLang === undefined ? 'en' : input.originalLang,
		publishedDate: input.publishedDate ?? null,
		summary: input.summary ?? null,
		creators: [],
		kindMetadata: input.kindMetadata ?? null,
	};
	const hints = {
		originalLang: input.originalLang === undefined ? 'en' : input.originalLang,
		publishedDate: null,
		summary: input.summaryHint ?? null,
	};
	const step = { do: async (name, _options, run) => (name.startsWith('acquire-') ? run({ attempt: 1 }) : null) };
	const context = { hints, processingId: 'contract', resolveSubject: () => input.subject ?? null };
	if (input.resourcePlatform) {
		const providerResponses = {
			[`/v0/item/${input.platformId}.json`]: {
				id: Number(input.platformId),
				type: 'story',
				title: acquired.title,
				text: acquired.markdown,
				time: acquired.publishedDate ? Date.parse(acquired.publishedDate) / 1000 : undefined,
				url: input.subject?.normalizedUrl,
			},
			'/graphql': {
				data: {
					post: {
						result: {
							_id: input.platformId,
							title: acquired.title,
							contents: { markdown: acquired.markdown },
							postedAt: acquired.publishedDate,
						},
					},
				},
			},
			'/twitter/tweets': {
				tweets: [
					{
						id: input.platformId,
						url,
						text: acquired.markdown,
						author: { userName: 'example', name: 'Example Author' },
						createdAt: acquired.publishedDate ?? '2026-09-01T00:00:00Z',
						lang: acquired.originalLang ?? undefined,
						...input.tweet,
					},
				],
			},
			'/twitter/article': input.article,
			'/youtube/v3/videos': {
				items: [
					{
						id: input.platformId,
						snippet: {
							title: acquired.title,
							description: acquired.summary ?? acquired.markdown,
							channelId: 'example',
							channelTitle: 'Example Channel',
							defaultAudioLanguage: acquired.originalLang ?? undefined,
							publishedAt: acquired.publishedDate ?? '2026-09-01T00:00:00Z',
							thumbnails: {},
						},
						contentDetails: { duration: 'PT2M' },
						statistics: {},
					},
				],
			},
			'/youtube/v3/channels': { items: [] },
		};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (request) => {
			const payload = providerResponses[new URL(request).pathname];
			assert.notEqual(payload, undefined, `Unexpected provider request: ${request}`);
			return Response.json(payload);
		};
		YoutubeTranscript.fetchTranscript = async () => input.transcript ?? [];
		const env = {
			YOUTUBE_API_KEY: 'fixture',
			KAITO_API_KEY: 'fixture',
			AI: {
				toMarkdown: (files) => Promise.all(files.map(async ({ name, blob }) => ({ name, format: 'markdown', data: await blob.text() }))),
			},
		};
		try {
			switch (input.resourcePlatform) {
				case 'hackernews':
					return await stageHackerNewsAcquisition(env, step, { ...context, itemId: input.platformId });
				case 'lesswrong':
					return await stageLessWrongAcquisition(step, input.platformId, hints);
				case 'twitter':
					return await stageTwitterAcquisition(env, step, { ...context, tweetId: input.platformId });
				case 'youtube':
					return await stageYouTubeAcquisition(env, step, { ...context, videoId: input.platformId });
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	}
	return (
		(await stagePaperResolution({}, step, {
			acquiredContent: acquired,
			hints,
			processingId: context.processingId,
			seedIdentifiers: input.resourceIdentifiers ?? [],
			sourceUrl: url,
			allowCitoidLookup: false,
		})) ?? (input.fileType === 'application/pdf' ? pdfResource(acquired, hints, url) : webResource(acquired, hints, url))
	);
}

const cases = [
	{
		name: 'generic blog',
		input: {},
		expected: { kind: 'blog', resourcePlatform: null, resourceIdentifiers: [] },
	},
	{
		name: 'PDF with a local DOI resolves without OpenAlex',
		input: {
			fileType: 'application/pdf',
			resourceIdentifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/local' }],
		},
		expected: {
			kind: 'paper',
			resourcePlatform: null,
			resourceIdentifiers: [{ preferred: true, scheme: 'doi', value: '10.1000/local' }],
			fileType: 'application/pdf',
			content: 'Example content',
			kindMetadata: {},
		},
	},
	{
		name: 'PDF without a paper identifier remains a readable PDF file',
		input: {
			fileType: 'application/pdf',
			kindMetadata: { siteName: 'example.com' },
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
	...[
		['hackernews', 'forum', '124', 'https://news.ycombinator.com/item?id=124'],
		['twitter', 'post', '125', 'https://x.com/example/status/125'],
		['youtube', 'video', 'abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk'],
		['lesswrong', 'blog', 'A2kJKqnHhh5Hq4p2S', 'https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug'],
	].map(([resourcePlatform, kind, platformId, url]) => ({
		name: `${resourcePlatform} retains its platform identity`,
		input: { resourcePlatform, platformId, url },
		expected: { kind, resourcePlatform, resourceIdentifiers: [{ preferred: true, scheme: resourcePlatform, value: platformId }] },
	})),
	{
		name: 'Twitter longform keeps its article content',
		input: {
			resourcePlatform: 'twitter',
			platformId: '132',
			tweet: { url: 'https://x.com/i/article/132' },
			article: { status: 'success', article: { title: 'Longform title', contents: [{ type: 'unstyled', text: 'Longform content' }] } },
		},
		expected: { title: 'Longform title', content: 'Longform content' },
	},
	{
		name: 'YouTube uses transcript content and preserves the source summary',
		input: {
			resourcePlatform: 'youtube',
			platformId: 'abcdefghijk',
			summary: 'Video description',
			summaryHint: 'Feed description',
			transcript: [{ offset: 0, duration: 1200, text: 'Transcript content', lang: 'ja' }],
		},
		expected: { content: 'Transcript content', summary: 'Video description', originalLang: 'ja' },
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

const unknownLanguage = await acquire({ originalLang: null });
assert.equal(unknownLanguage.originalLang, 'und', 'unknown acquisition language must stay provisional until analysis');

for (const testCase of cases) {
	const actual = await acquire(testCase.input);
	assert.deepEqual(Object.fromEntries(Object.keys(testCase.expected).map((key) => [key, actual[key]])), testCase.expected, testCase.name);
}

const migratedCarrier = await acquire({
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
	(
		await acquire({
			kind: 'forum',
			platformId: '127',
			resourcePlatform: 'hackernews',
			url: 'https://news.ycombinator.com/item?id=127',
			subject: paperSubject,
		})
	).subject,
	{ ...paperSubject, publishedDate: null },
	'acquisition keeps the already-resolved paper subject',
);

// A subject page routinely publishes no date of its own; the carrier's date
// travels with it so the subject can still be placed chronologically.
assert.deepEqual(
	(
		await acquire({
			kind: 'forum',
			platformId: '128',
			resourcePlatform: 'hackernews',
			publishedDate: '2026-08-29T14:02:10.000Z',
			url: 'https://news.ycombinator.com/item?id=128',
			subject: paperSubject,
		})
	).subject,
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
			{ height: 480, kind: 'image', url: imageA, width: 640 },
			{ height: 360, kind: 'image', url: imageB, width: 640 },
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
	{ deliveryUrl: `https://imagedelivery.net/account/resource-${'a'.repeat(64)}/public`, height: 800, sourceUrl: imageA, width: 1200 },
	{ deliveryUrl: `https://imagedelivery.net/account/resource-${'b'.repeat(64)}/public`, height: 1200, sourceUrl: imageB, width: 800 },
	{ deliveryUrl: `https://imagedelivery.net/account/resource-${'c'.repeat(64)}/public`, height: null, sourceUrl: avatar, width: null },
];
const canonicalImages = hostedResourceImageFields(imageInput, hosted);
assert.deepEqual(
	{ height: canonicalImages.ogImageHeight, url: canonicalImages.ogImageUrl, width: canonicalImages.ogImageWidth },
	{ height: 1200, url: hosted[1].deliveryUrl, width: 800 },
);
assert.deepEqual(
	canonicalImages.kindMetadata.attachments.map(({ height, width }) => ({ height, width })),
	[
		{ height: 480, width: 640 },
		{ height: 360, width: 640 },
	],
	'attachment dimensions remain provider-owned',
);
assert.deepEqual(
	resourceImageSourceUrls(canonicalImages),
	hosted.map(({ deliveryUrl }) => deliveryUrl),
);
assert.throws(() => hostedResourceImageFields(imageInput, hosted.slice(0, 1)), /do not cover every source/);

const summaryCases = [
	{ summary: 'Source description', summaryHint: 'Feed description', expected: 'Source description' },
	{ summary: null, summaryHint: 'Feed description', expected: 'Feed description' },
	{ summary: '   ', summaryHint: 'Feed description', expected: 'Feed description' },
	{ summary: '   ', summaryHint: '   ', expected: null },
];
for (const { expected, ...input } of summaryCases) assert.equal((await acquire(input)).summary, expected);

console.info(`Platform acquisition contract checks passed (${cases.length + 7 + summaryCases.length} cases).`);
