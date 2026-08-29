import assert from 'node:assert/strict';
import {
	isAllowedPublicPdfUrl,
	LLAMA_PARSE_MAX_PAGES,
	llamaParseAdmissionReason,
	wholeDocumentMarkdown,
} from '../src/ingest/platforms/pdf-fallback-policy.ts';

const admission = (overrides = {}) =>
	llamaParseAdmissionReason({
		grant: { maxPages: LLAMA_PARSE_MAX_PAGES },
		hasCredentials: true,
		local: { hardDefects: ['needs-ocr'], totalPages: 3 },
		source: { kind: 'public-url', url: 'https://papers.example.org/work.pdf' },
		...overrides,
	});

assert.equal(admission(), 'admitted');
assert.equal(admission({ source: { kind: 'private-upload' } }), 'admitted');
assert.equal(admission({ local: { hardDefects: [], totalPages: 3 } }), 'local-usable');
assert.equal(admission({ local: { hardDefects: ['complex-layout'], totalPages: 3 } }), 'local-usable');
assert.equal(admission({ grant: null }), 'not-authorized');
assert.equal(admission({ grant: { maxPages: LLAMA_PARSE_MAX_PAGES + 1 } }), 'invalid-grant');
assert.equal(admission({ hasCredentials: false }), 'missing-credentials');
assert.equal(admission({ local: { hardDefects: ['parse-failed'], totalPages: null } }), 'page-count-unknown');
assert.equal(admission({ local: { hardDefects: ['unparsed'], totalPages: LLAMA_PARSE_MAX_PAGES } }), 'admitted');
assert.equal(admission({ local: { hardDefects: ['unparsed'], totalPages: LLAMA_PARSE_MAX_PAGES + 1 } }), 'page-limit-exceeded');
assert.equal(admission({ local: { hardDefects: ['unparsed'], totalPages: 0 } }), 'page-limit-exceeded');
assert.equal(admission({ source: { kind: 'public-url', url: 'https://localhost/work.pdf' } }), 'source-ineligible');

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
assert.equal(wholeDocumentMarkdown([{ markdown: '\u0000\u0001\u0002broken', page_number: 1, success: true }], 1), null);

console.info({ event: 'llama_parse_policy_contract_smoke_passed' });
