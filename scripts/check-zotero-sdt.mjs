import assert from 'node:assert/strict';
import {
	normalizeStructuredPdf,
	parseStructuredPdfDocumentJson,
	parseStructuredPdfFailure,
	structuredPdfStorageKey,
} from '../src/ingest/zotero-sdt.ts';

const text = (value, options = {}) => ({
	anchor: { pageRects: [[0, 10, 10, 20, 20]], textMap: JSON.stringify([[0, 0, 0, value.length, 10, 10, 20, 20]]) },
	text: value,
	...options,
});

const document = {
	catalog: {
		outline: [
			{ ref: [1], title: 'Introduction' },
			{ ref: [3], title: 'References' },
		],
		pages: [{ contentRange: [[0], [3]], textSource: 'born-digital' }],
	},
	content: [
		{ content: [text('Running header')], flowClass: 'excluded', type: 'paragraph' },
		{ content: [text('Introduction')], type: 'heading' },
		{
			content: [
				text('Prior work '),
				text('[1]', { refs: [[3, 0]] }),
				text(' established the result'),
				text('2', { style: { sup: true } }),
				text('.'),
			],
			type: 'paragraph',
		},
		{
			content: [
				{
					content: [text('[1] Example, A. A useful paper. Journal 1 (2024). https://doi.org/10.1000/example')],
					reference: true,
					type: 'listitem',
				},
			],
			ordered: true,
			type: 'list',
		},
	],
	metadata: {
		characterCount: 139,
		processor: { type: 'pdf', version: 2 },
		source: {
			contentType: 'application/pdf',
			hash: '0123456789abcdef0123456789abcdef',
			properties: { DOI: '10.1000/example', Title: 'A useful paper' },
		},
	},
	schemaVersion: '1.0.0',
};

const parsed = parseStructuredPdfDocumentJson(JSON.stringify(document));
const normalized = normalizeStructuredPdf(parsed);

assert.equal(normalized.references.length, 1);
assert.deepEqual(normalized.references[0], {
	key: 'sdt-1',
	label: '1',
	text: 'Example, A. A useful paper. Journal 1 (2024). https://doi.org/10.1000/example',
});
assert.equal(normalized.mentions.length, 1);
assert.deepEqual(normalized.mentions[0].targetKeys, ['sdt-1']);
assert.equal(normalized.markdown.slice(normalized.mentions[0].contentStart, normalized.mentions[0].contentEnd), '[1]');
assert.match(normalized.mentions[0].context, /Prior work \[1\] established the result2\./u);
assert.equal(normalized.mentions[0].section, 'Introduction');
assert.doesNotMatch(normalized.markdown, /Running header|<sup>|<sub>/u);
assert.match(normalized.markdown, /^# Introduction/u);
assert.match(normalized.paperIdentifierText ?? '', /DOI: 10\.1000\/example/u);
assert.equal(normalized.parse.totalPages, 1);
assert.equal(normalized.parse.fullPageImagePages, 0);
assert.equal(structuredPdfStorageKey('users/u/resources/r/source.pdf'), 'users/u/resources/r/source.pdf.structured-document.json');
assert.deepEqual(parseStructuredPdfFailure(422, '{"error":"model failed","totalPages":12}'), {
	message: 'Zotero SDT parse failed with 422: model failed',
	totalPages: 12,
});
assert.deepEqual(parseStructuredPdfFailure(500, 'not-json'), {
	message: 'Zotero SDT parse failed with 500',
	totalPages: null,
});

console.info({
	event: 'zotero_sdt_contract_passed',
	markdownCharacters: normalized.markdown.length,
	mentions: normalized.mentions.length,
	references: normalized.references.length,
});
