import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'cloudflare:workflows') {
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		}
		if (specifier.startsWith('@core-shared/')) {
			return { shortCircuit: true, url: new URL(`../src/shared/${specifier.slice('@core-shared/'.length)}.ts`, import.meta.url).href };
		}
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/workers/core-worker/src/')) {
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		}
		return nextResolve(specifier, context);
	},
});

const [resource, hackerNews, lessWrong, twitter, youtube] = await Promise.all([
	import('../src/shared/resource.ts'),
	import('../src/ingest/platforms/hackernews.ts'),
	import('../src/ingest/platforms/lesswrong.ts'),
	import('../src/ingest/platforms/twitter-acquisition.ts'),
	import('../src/ingest/platforms/youtube-acquisition.ts'),
]);

function detectResourceUrl(value) {
	const url = URL.parse(value);
	if (!url) return null;
	const hostname = url.hostname.toLowerCase();
	if (hostname === 'ycombinator.com' || hostname.endsWith('.ycombinator.com')) return hackerNews.parseHackerNewsResourceUrl(url);
	if (hostname === 'lesswrong.com' || hostname.endsWith('.lesswrong.com')) return lessWrong.parseLessWrongResourceUrl(url);
	if (hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com')) {
		return twitter.parseTwitterResourceUrl(url);
	}
	if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be' || hostname.endsWith('.youtu.be')) {
		return youtube.parseYouTubeResourceUrl(url);
	}
	return null;
}

const platformUrlCases = [
	['https://twitter.com/openai/status/1234567890?s=20', ['twitter', '1234567890', 'https://x.com/i/status/1234567890']],
	[
		'https://news.ycombinator.com/item?id=12345678&utm_source=feed',
		['hackernews', '12345678', 'https://news.ycombinator.com/item?id=12345678'],
	],
	['https://youtu.be/dQw4w9WgXcQ?t=43', ['youtube', 'dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ']],
	[
		'https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug',
		['lesswrong', 'A2kJKqnHhh5Hq4p2S', 'https://lesswrong.com/posts/A2kJKqnHhh5Hq4p2S'],
	],
	['https://example.com/article', null],
	['https://example.com/openai/status/1234567890', null],
	['https://news.ycombinator.com/item?id=0', null],
	['https://x.com/openai/status/not-a-tweet', null],
	['https://x.com/openai/status/123abc', null],
	['https://youtu.be/too-short', null],
	['https://lesswrong.com/posts/short', null],
];
for (const [input, expected] of platformUrlCases) {
	const actual = detectResourceUrl(input);
	assert.deepEqual(actual ? [actual.resourcePlatform, actual.platformId, actual.canonicalUrl] : null, expected, input);
}

const twitterUsernameCases = [
	['openai', 'openai'],
	['@OpenAI', 'OpenAI'],
	['https://x.com/openai', 'openai'],
	['https://twitter.com/OpenAI/status/123', 'OpenAI'],
	['https://x.com/home', null],
	['https://x.com/search?q=openai', null],
	['https://example.com/openai', null],
];
for (const [input, expected] of twitterUsernameCases) {
	assert.equal(twitter.parseTwitterProfileInput(input, URL.parse(input)), expected);
}

const canonicalIdentifiers = [
	{ preferred: true, scheme: 'doi', value: '10.1000/example' },
	{ preferred: true, scheme: 'youtube', value: 'dQw4w9WgXcQ' },
];
assert.deepEqual(resource.ResourceIdentifiersSchema.parse(canonicalIdentifiers), canonicalIdentifiers);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'doi', value: ' 10.1000/EXAMPLE ' }]).success, false);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: false, scheme: 'twitter', value: '123' }]).success, false);
assert.equal(
	resource.ResourceIdentifiersSchema.safeParse([
		{ preferred: true, scheme: 'arxiv', value: '2401.12345' },
		{ preferred: true, scheme: 'arxiv', value: '2402.12345' },
	]).success,
	false,
);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'youtube', value: 'too-short' }]).success, false);

console.info({
	event: 'resource_contract_smoke_passed',
	identifierContractCases: 5,
	twitterUsernameCases: twitterUsernameCases.length,
	urlCases: platformUrlCases.length,
});
