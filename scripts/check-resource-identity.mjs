import assert from 'node:assert/strict';
import { isResourceIdentifierCompatibleWithIdentity } from '../src/shared/resource-identifiers.ts';
import {
	isResourceSourceSnapshotHash,
	isResourceTranslationIdentityEligible,
	isValidKindPlatform,
	resourceIdentityForDetectedPlatform,
	VALID_KIND_PLATFORMS,
} from '../src/shared/resource-types.ts';
import { detectResourcePlatform } from '../src/shared/url.ts';

const canonicalIdentities = Object.entries(VALID_KIND_PLATFORMS).flatMap(([kind, resourcePlatforms]) =>
	resourcePlatforms.map((resourcePlatform) => ({ kind, resourcePlatform })),
);
for (const identity of canonicalIdentities) {
	assert.equal(isValidKindPlatform(identity.kind, identity.resourcePlatform), true, JSON.stringify(identity));
}
assert.equal(isValidKindPlatform('post', null), false);
assert.equal(isValidKindPlatform('blog', 'hackernews'), false);
assert.equal(isValidKindPlatform('forum', null), false);
assert.equal(isValidKindPlatform('paper', 'hackernews'), false);
assert.equal(isValidKindPlatform('document', null), false);
const translationCases = [
	['generic blog', { kind: 'blog', resourcePlatform: null, fileType: null }, true],
	['Hacker News forum with PDF representation', { kind: 'forum', resourcePlatform: 'hackernews', fileType: 'application/pdf' }, true],
	['direct PDF', { kind: 'blog', resourcePlatform: null, fileType: 'application/pdf' }, false],
	['post', { kind: 'post', resourcePlatform: 'twitter', fileType: null }, true],
	['video', { kind: 'video', resourcePlatform: 'youtube', fileType: null }, false],
	['web paper', { kind: 'paper', resourcePlatform: null, fileType: null }, true],
	['direct PDF paper', { kind: 'paper', resourcePlatform: null, fileType: 'application/pdf' }, false],
	['image', { kind: 'image', resourcePlatform: null, fileType: 'image/png' }, false],
	['file', { kind: 'file', resourcePlatform: null, fileType: 'text/csv' }, false],
];

for (const [label, identity, expected] of translationCases) {
	assert.equal(isResourceTranslationIdentityEligible(identity), expected, `${label} translation eligibility`);
}

assert.equal(detectResourcePlatform('https://x.com/openai/status/1234567890'), 'twitter');
assert.equal(detectResourcePlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
assert.equal(detectResourcePlatform('https://news.ycombinator.com/item?id=12345678'), 'hackernews');
assert.equal(detectResourcePlatform('https://example.com/article'), null);

assert.deepEqual(resourceIdentityForDetectedPlatform('twitter'), { kind: 'post', resourcePlatform: 'twitter' });
assert.deepEqual(resourceIdentityForDetectedPlatform('youtube'), { kind: 'video', resourcePlatform: 'youtube' });
assert.deepEqual(resourceIdentityForDetectedPlatform('hackernews'), { kind: 'forum', resourcePlatform: 'hackernews' });
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
];
for (const [identifier, identity, expected] of identifierCompatibilityCases) {
	assert.equal(isResourceIdentifierCompatibleWithIdentity(identifier, identity), expected);
}

console.info({
	event: 'resource_identity_smoke_passed',
	canonicalIdentityCases: canonicalIdentities.length,
	detectedPlatformIdentityCases: 3,
	invalidIdentityCases: 5,
	identifierCompatibilityCases: identifierCompatibilityCases.length,
	sourceRevisionCases: 4,
	translationCases: translationCases.length,
	urlCases: 4,
});
