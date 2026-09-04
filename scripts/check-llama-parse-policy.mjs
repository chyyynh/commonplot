import assert from 'node:assert/strict';
import {
	isAllowedPublicPdfUrl,
	LLAMA_PARSE_MAX_PAGES,
	llamaParseAdmissionReason,
	localPdfNeedsFallback,
	wholeDocumentMarkdown,
} from '../src/ingest/platforms/pdf-fallback-policy.ts';

const local = (overrides = {}) => ({
	fallbackReasons: ['empty-output'],
	fullPageImagePages: 0,
	parsedPages: 3,
	totalPages: 3,
	...overrides,
});
const admission = (overrides = {}) =>
	llamaParseAdmissionReason({
		grant: { maxPages: LLAMA_PARSE_MAX_PAGES },
		hasCredentials: true,
		local: local(),
		source: { kind: 'public-url', url: 'https://papers.example.org/work.pdf' },
		...overrides,
	});

assert.equal(admission(), 'admitted');
assert.equal(admission({ source: { kind: 'private-upload' } }), 'admitted');
assert.equal(admission({ local: local({ fallbackReasons: [] }) }), 'local-usable');
assert.equal(admission({ grant: null }), 'not-authorized');
assert.equal(admission({ grant: { maxPages: LLAMA_PARSE_MAX_PAGES + 1 } }), 'invalid-grant');
assert.equal(admission({ hasCredentials: false }), 'missing-credentials');
assert.equal(admission({ local: local({ fallbackReasons: ['parse-failed'], parsedPages: 0, totalPages: null }) }), 'page-count-unknown');
assert.equal(
	admission({ local: local({ fallbackReasons: ['empty-output'], parsedPages: 100, totalPages: LLAMA_PARSE_MAX_PAGES }) }),
	'admitted',
);
assert.equal(
	admission({
		local: local({ fallbackReasons: ['empty-output'], parsedPages: 101, totalPages: LLAMA_PARSE_MAX_PAGES + 1 }),
	}),
	'page-limit-exceeded',
);
assert.equal(admission({ local: local({ fallbackReasons: ['empty-output'], parsedPages: 0, totalPages: 0 }) }), 'page-limit-exceeded');
assert.equal(admission({ source: { kind: 'public-url', url: 'https://localhost/work.pdf' } }), 'source-ineligible');

assert.equal(localPdfNeedsFallback(local({ fallbackReasons: [], fullPageImagePages: 8, parsedPages: 10 })), true);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: [], fullPageImagePages: 7, parsedPages: 10 })), false);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: [], fullPageImagePages: 0, parsedPages: 0 })), false);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: ['empty-output'], parsedPages: 10 })), true);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: ['parse-failed'], parsedPages: 0 })), true);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: ['degraded-page'], parsedPages: 10 })), false);
const imageBacked = local({ fallbackReasons: [], fullPageImagePages: 8, parsedPages: 10, totalPages: 10 });
assert.equal(admission({ local: imageBacked }), 'admitted');
assert.equal(admission({ grant: null, local: imageBacked }), 'not-authorized');
assert.equal(admission({ grant: { maxPages: 9 }, local: imageBacked }), 'page-limit-exceeded');

assert.equal(isAllowedPublicPdfUrl('https://papers.example.org/work.pdf'), true);
for (const url of [
	'http://papers.example.org/work.pdf',
	'https://localhost/work.pdf',
	'https://127.0.0.1/work.pdf',
	'https://[::1]/work.pdf',
	'https://papers.example.org./work.pdf',
	'https://service.internal/work.pdf',
	'https://intranet/work.pdf',
	'https://user:pass@papers.example.org/work.pdf',
]) {
	assert.equal(isAllowedPublicPdfUrl(url), false, url);
}

assert.equal(
	wholeDocumentMarkdown(
		[
			{ markdown: 'second', page_number: 2, success: true },
			{ markdown: 'first', page_number: 1, success: true },
		],
		2,
	),
	'first\n\nsecond',
);
assert.equal(wholeDocumentMarkdown([{ markdown: 'first', page_number: 1, success: true }], 2), null);
assert.equal(wholeDocumentMarkdown([{ markdown: 'first', page_number: 1, success: false }], 1), null);
assert.equal(wholeDocumentMarkdown([{ markdown: '\u0000broken', page_number: 1, success: true }], 1), 'broken');
assert.equal(wholeDocumentMarkdown([{ markdown: '\u0000\u0000', page_number: 1, success: true }], 1), null);

console.info({ event: 'llama_parse_policy_contract_smoke_passed' });
