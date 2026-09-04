import assert from 'node:assert/strict';
import { shouldEnqueueResourceTranslation } from '../src/ingest/translation-policy.ts';

const candidate = (overrides = {}) => ({
	fileType: 'application/pdf',
	kind: 'paper',
	originalLang: 'en',
	resourcePlatform: null,
	scope: 'corpus',
	url: 'https://doi.org/10.1000/example',
	...overrides,
});

assert.equal(shouldEnqueueResourceTranslation(candidate()), true, 'canonical PDF papers must be translated');
assert.equal(
	shouldEnqueueResourceTranslation(candidate({ kind: 'file', scope: 'private', url: null })),
	true,
	'private uploaded PDFs must remain translatable before canonicalization',
);
assert.equal(shouldEnqueueResourceTranslation(candidate({ kind: 'file' })), false, 'corpus PDF files are not papers');
assert.equal(shouldEnqueueResourceTranslation(candidate({ originalLang: 'zh-Hant' })), false, 'target-language papers need no translation');
assert.equal(
	shouldEnqueueResourceTranslation(candidate({ resourcePlatform: 'youtube' })),
	false,
	'platform carriers cannot enter the platformless PDF path',
);
assert.equal(
	shouldEnqueueResourceTranslation(candidate({ fileType: null, kind: 'blog', url: 'https://example.com/article' })),
	true,
	'ordinary corpus resources remain translatable',
);

console.info({ event: 'translation_policy_contract_smoke_passed' });
