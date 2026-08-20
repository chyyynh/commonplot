import assert from 'node:assert/strict';
import { isResourceIdentifierCompatibleWithIdentity } from '../src/shared/resource-identifiers.ts';
import {
	isResourceSourceSnapshotHash,
	parseResourceIdentity,
	resourceIdentityForDetectedPlatform,
	VALID_KIND_PLATFORMS,
} from '../src/shared/resource-types.ts';
import { detectResourceUrl, parseTwitterUsername } from '../src/shared/url.ts';

const canonicalIdentities = Object.entries(VALID_KIND_PLATFORMS).flatMap(([kind, resourcePlatforms]) =>
	resourcePlatforms.map((resourcePlatform) => ({ kind, resourcePlatform })),
);
for (const identity of canonicalIdentities) {
	assert.deepEqual(parseResourceIdentity(identity.kind, identity.resourcePlatform), identity);
}
assert.equal(parseResourceIdentity('post', null), null);
assert.equal(parseResourceIdentity('blog', 'hackernews'), null);
assert.equal(parseResourceIdentity('forum', null), null);
assert.equal(parseResourceIdentity('paper', 'hackernews'), null);
assert.equal(parseResourceIdentity('document', null), null);

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

assert.deepEqual(resourceIdentityForDetectedPlatform('twitter'), { kind: 'post', resourcePlatform: 'twitter' });
assert.deepEqual(resourceIdentityForDetectedPlatform('youtube'), { kind: 'video', resourcePlatform: 'youtube' });
assert.deepEqual(resourceIdentityForDetectedPlatform('hackernews'), { kind: 'forum', resourcePlatform: 'hackernews' });
assert.deepEqual(resourceIdentityForDetectedPlatform('lesswrong'), { kind: 'blog', resourcePlatform: 'lesswrong' });
assert.equal(isResourceSourceSnapshotHash('a'.repeat(64)), true);
assert.equal(isResourceSourceSnapshotHash('A'.repeat(64)), false);
assert.equal(isResourceSourceSnapshotHash('a'.repeat(63)), false);
assert.equal(isResourceSourceSnapshotHash(null), false);

const identifierCompatibilityCases = [
	[{ preferred: true, scheme: 'hackernews', value: '123' }, { kind: 'forum', resourcePlatform: 'hackernews' }, true],
	[{ preferred: true, scheme: 'hackernews', value: '123' }, { kind: 'paper', resourcePlatform: null }, false],
	[{ preferred: true, scheme: 'doi', value: '10.1000/example' }, { kind: 'paper', resourcePlatform: null }, true],
	[{ preferred: true, scheme: 'doi', value: '10.1000/example' }, { kind: 'blog', resourcePlatform: null }, false],
	[{ preferred: true, scheme: 'twitter', value: '123' }, { kind: 'post', resourcePlatform: 'twitter' }, true],
	[{ preferred: true, scheme: 'youtube', value: 'abcdefghijk' }, { kind: 'video', resourcePlatform: 'youtube' }, true],
	[{ preferred: true, scheme: 'lesswrong', value: 'A2kJKqnHhh5Hq4p2S' }, { kind: 'blog', resourcePlatform: 'lesswrong' }, true],
	[{ preferred: true, scheme: 'lesswrong', value: 'A2kJKqnHhh5Hq4p2S' }, { kind: 'blog', resourcePlatform: null }, false],
];
for (const [identifier, identity, expected] of identifierCompatibilityCases) {
	assert.equal(isResourceIdentifierCompatibleWithIdentity(identifier, identity), expected);
}

console.info({
	event: 'resource_identity_smoke_passed',
	canonicalIdentityCases: canonicalIdentities.length,
	detectedPlatformIdentityCases: 4,
	invalidIdentityCases: 5,
	identifierCompatibilityCases: identifierCompatibilityCases.length,
	sourceRevisionCases: 4,
	twitterUsernameCases: twitterUsernameCases.length,
	urlCases: 5,
});
