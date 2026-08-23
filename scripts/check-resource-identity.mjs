import assert from 'node:assert/strict';
import { TwitterProviderSequenceSchema } from '../../../web-tanstack/src/server/domain/resource-graph-contracts.ts';
import { ResourceIdentifiersSchema } from '../src/shared/resource.ts';
import { detectResourceUrl, normalizeUrl, parseTwitterUsername } from '../src/shared/url.ts';

assert.deepEqual(detectResourceUrl('https://x.com/openai/status/1234567890'), {
	resourcePlatform: 'twitter',
	platformId: '1234567890',
});
assert.deepEqual(detectResourceUrl('https://youtu.be/dQw4w9WgXcQ'), {
	resourcePlatform: 'youtube',
	platformId: 'dQw4w9WgXcQ',
});
assert.deepEqual(detectResourceUrl('https://news.ycombinator.com/item?id=12345678'), {
	resourcePlatform: 'hackernews',
	platformId: '12345678',
});
assert.deepEqual(detectResourceUrl('https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug'), {
	resourcePlatform: 'lesswrong',
	platformId: 'A2kJKqnHhh5Hq4p2S',
});
assert.equal(detectResourceUrl('https://example.com/article'), null);

const canonicalPlatformUrlCases = [
	['https://twitter.com/openai/status/1234567890?s=20', 'https://x.com/i/status/1234567890'],
	['https://news.ycombinator.com/item?id=12345678&utm_source=feed', 'https://news.ycombinator.com/item?id=12345678'],
	['https://youtu.be/dQw4w9WgXcQ?t=43', 'https://youtube.com/watch?v=dQw4w9WgXcQ'],
	['https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug', 'https://lesswrong.com/posts/A2kJKqnHhh5Hq4p2S'],
];
for (const [input, expected] of canonicalPlatformUrlCases) assert.equal(normalizeUrl(input), expected);

const twitterUsernameCases = [
	['openai', 'openai'],
	['@OpenAI', 'OpenAI'],
	['https://x.com/openai', 'openai'],
	['https://twitter.com/OpenAI/status/123', 'OpenAI'],
	['https://x.com/home', null],
	['https://x.com/search?q=openai', null],
	['https://example.com/openai', null],
];
for (const [input, expected] of twitterUsernameCases) assert.equal(parseTwitterUsername(input), expected);

assert.equal(TwitterProviderSequenceSchema.safeParse('1').success, true);
assert.equal(TwitterProviderSequenceSchema.safeParse('1999999999999999999').success, true);
assert.equal(TwitterProviderSequenceSchema.safeParse('0').success, false);
assert.equal(TwitterProviderSequenceSchema.safeParse('9223372036854775808').success, false);
assert.equal(TwitterProviderSequenceSchema.safeParse('not-a-sequence').success, false);

const canonicalIdentifiers = [
	{ preferred: true, scheme: 'doi', value: '10.1000/example' },
	{ preferred: true, scheme: 'youtube', value: 'dQw4w9WgXcQ' },
];
assert.deepEqual(ResourceIdentifiersSchema.parse(canonicalIdentifiers), canonicalIdentifiers);
assert.equal(ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'doi', value: ' 10.1000/EXAMPLE ' }]).success, false);
assert.equal(ResourceIdentifiersSchema.safeParse([{ preferred: false, scheme: 'twitter', value: '123' }]).success, false);
assert.equal(
	ResourceIdentifiersSchema.safeParse([
		{ preferred: true, scheme: 'arxiv', value: '2401.12345' },
		{ preferred: true, scheme: 'arxiv', value: '2402.12345' },
	]).success,
	false,
);
assert.equal(ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'youtube', value: 'too-short' }]).success, false);

console.info({
	event: 'resource_contract_smoke_passed',
	identifierContractCases: 5,
	providerSequenceCases: 5,
	twitterUsernameCases: twitterUsernameCases.length,
	urlCases: 5,
	canonicalPlatformUrlCases: canonicalPlatformUrlCases.length,
});
