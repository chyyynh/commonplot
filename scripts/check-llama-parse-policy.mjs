import assert from 'node:assert/strict';
import {
	isAllowedPublicPdfUrl,
	LLAMA_PARSE_MAX_PAGES,
	llamaParseFallbackReason,
	wholeDocumentMarkdown,
} from '../src/ingest/platforms/llama-parse-policy.ts';

const admission = (overrides = {}) =>
	llamaParseFallbackReason({
		enabled: 'true',
		hasApiKey: true,
		hasProjectId: true,
		local: { hardDefects: ['needs-ocr'], totalPages: 3 },
		scope: 'public',
		...overrides,
	});

assert.equal(admission(), 'admitted');
assert.equal(admission({ local: { hardDefects: [], totalPages: 3 } }), 'local-usable');
assert.equal(admission({ local: { hardDefects: ['complex-layout'], totalPages: 3 } }), 'local-usable');
assert.equal(admission({ enabled: 'false' }), 'disabled');
assert.equal(admission({ hasApiKey: false }), 'missing-credentials');
assert.equal(admission({ local: { hardDefects: ['parse-failed'], totalPages: null } }), 'page-count-unknown');
assert.equal(admission({ local: { hardDefects: ['unparsed'], totalPages: LLAMA_PARSE_MAX_PAGES + 1 } }), 'page-limit-exceeded');
assert.equal(admission({ scope: 'private' }), 'private-source');

assert.equal(isAllowedPublicPdfUrl('https://papers.example.org/work.pdf'), true);
for (const url of [
	'http://papers.example.org/work.pdf',
	'https://localhost/work.pdf',
	'https://127.0.0.1/work.pdf',
	'https://[::1]/work.pdf',
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

console.info({ event: 'llama_parse_policy_contract_smoke_passed' });
