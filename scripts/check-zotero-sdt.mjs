import assert from 'node:assert/strict';
import {
	normalizeStructuredPdf,
	parseStructuredPdfDocumentJson,
	parseStructuredPdfFailure,
	structuredPdfSourceCrops,
	structuredPdfSourceCropUrl,
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
			{ ref: [4], title: 'References' },
		],
		pages: [{ contentRange: [[0], [4]], textSource: 'born-digital' }],
	},
	content: [
		{ content: [text('Running header')], flowClass: 'excluded', type: 'paragraph' },
		{ content: [text('Introduction')], type: 'heading' },
		{
			content: [text('Prior work '), text('[1]', { refs: [[4, 0]] })],
			nextPart: [3],
			type: 'paragraph',
		},
		{
			content: [text(' established the result'), text('2', { style: { sup: true } }), text('.')],
			previousPart: [2],
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
assert.match(normalized.markdown, /^## Introduction/u);
assert.match(normalized.paperIdentifierText ?? '', /DOI: 10\.1000\/example/u);
assert.equal(normalized.parse.totalPages, 1);
assert.equal(normalized.parse.fullPageImagePages, 0);
assert.equal(structuredPdfStorageKey('users/u/resources/r/source.pdf'), 'users/u/resources/r/source.pdf.structured-document.json');
assert.equal(structuredPdfSourceCropUrl('a'.repeat(64), '12-p3'), `/api/media/asset/pdf-crops/${'a'.repeat(64)}/12-p3.png`);
assert.deepEqual(parseStructuredPdfFailure(422, '{"error":"model failed","totalPages":12}'), {
	message: 'Zotero SDT parse failed with 422: model failed',
	totalPages: 12,
});
assert.deepEqual(parseStructuredPdfFailure(500, 'not-json'), {
	message: 'Zotero SDT parse failed with 500',
	totalPages: null,
});

const positionedText = (value, page) =>
	text(value, {
		anchor: {
			pageRects: [[page, 10, 10, 20, 20]],
			textMap: JSON.stringify([[0, page, 0, value.length, 10, 10, 20, 20]]),
		},
	});
const paragraph = (value, pageRects, options = {}) => ({
	anchor: { pageRects },
	content: [positionedText(value, pageRects[0][0])],
	type: 'paragraph',
	...options,
});
const seamDocument = {
	...document,
	catalog: {
		outline: [],
		pages: [
			{ contentRange: [[0], [4]], textSource: 'born-digital' },
			{ contentRange: [[5], [8]], textSource: 'born-digital' },
		],
	},
	content: [
		paragraph('These applications have important', [[0, 54, 80, 295, 120]], { nextPart: [1] }),
		paragraph('functionality.', [[0, 317, 700, 558, 735]], { previousPart: [0] }),
		paragraph('lowercase starts a real new paragraph.', [[0, 317, 620, 558, 680]]),
		paragraph('A label without terminal punctuation', [[0, 54, 80, 295, 120]]),
		paragraph('lowercase text below it remains separate.', [[0, 317, 700, 558, 735]]),
		paragraph('This paragraph continues across the next page', [[0, 317, 70, 558, 100]], { nextPart: [8] }),
		paragraph('Running header', [[0, 54, 755, 558, 765]], { flowClass: 'excluded' }),
		paragraph('1278', [[0, 296, 26, 316, 35]], { flowClass: 'excluded' }),
		paragraph('without being interrupted by excluded furniture.', [[1, 54, 700, 295, 735]], { previousPart: [5] }),
	],
};
const seamNormalized = normalizeStructuredPdf(parseStructuredPdfDocumentJson(JSON.stringify(seamDocument)));
assert.match(seamNormalized.markdown, /These applications have important functionality\./u);
assert.doesNotMatch(seamNormalized.markdown, /important\n\nfunctionality/u);
assert.match(seamNormalized.markdown, /functionality\.\n\nlowercase starts a real new paragraph\./u);
assert.match(seamNormalized.markdown, /A label without terminal punctuation\n\nlowercase text below it remains separate\./u);
assert.match(seamNormalized.markdown, /This paragraph continues across the next page without being interrupted by excluded furniture\./u);
assert.doesNotMatch(seamNormalized.markdown, /Running header|1278/u);

const hyphenDocument = {
	...document,
	catalog: {
		outline: [],
		pages: [{ contentRange: [[0], [1]], textSource: 'born-digital' }],
	},
	content: [
		paragraph('multi-', [[0, 54, 80, 295, 120]], { nextPart: [1] }),
		paragraph('column layout', [[0, 317, 700, 558, 735]], { previousPart: [0] }),
	],
};
assert.equal(normalizeStructuredPdf(parseStructuredPdfDocumentJson(JSON.stringify(hyphenDocument))).markdown, 'multicolumn layout');

const invalidPartDocument = JSON.parse(JSON.stringify(document));
invalidPartDocument.content[2].nextPart = [];
assert.throws(() => parseStructuredPdfDocumentJson(JSON.stringify(invalidPartDocument)), /nextPart/u);

const cropDocument = {
	...document,
	catalog: {
		outline: [],
		pages: [{ contentRange: [[0], [2]], textSource: 'born-digital' }],
	},
	content: [
		{
			anchor: { pageRects: [[0, 20, 40, 220, 180]] },
			content: [text('Research model')],
			type: 'image',
		},
		{
			anchor: { pageRects: [[0, 30, 200, 260, 500]] },
			content: [text('Visible cues Social inferences Representative quote')],
			type: 'table',
		},
	],
};
const parsedCropDocument = parseStructuredPdfDocumentJson(JSON.stringify(cropDocument));
assert.deepEqual(
	structuredPdfSourceCrops(parsedCropDocument).map(({ blockPath, id, kind, pageIndex, rect }) => ({
		blockPath,
		id,
		kind,
		pageIndex,
		rect,
	})),
	[
		{ blockPath: '0', id: '0-p0', kind: 'image', pageIndex: 0, rect: [20, 40, 220, 180] },
		{ blockPath: '1', id: '1-p0', kind: 'table', pageIndex: 0, rect: [30, 200, 260, 500] },
	],
);
const cropWithoutManifest = normalizeStructuredPdf(parsedCropDocument, { inputContentHash: 'a'.repeat(64) });
assert.doesNotMatch(cropWithoutManifest.markdown, /\/api\/media\/asset\/pdf-crops/u);
const partiallyReadyCrop = normalizeStructuredPdf(parsedCropDocument, {
	inputContentHash: 'a'.repeat(64),
	readySourceCropIds: new Set(['0-p0']),
});
assert.match(partiallyReadyCrop.markdown, /\/0-p0\.png/u);
assert.doesNotMatch(partiallyReadyCrop.markdown, /\/1-p0\.png/u);
const cropNormalized = normalizeStructuredPdf(parsedCropDocument, {
	inputContentHash: 'a'.repeat(64),
	readySourceCropIds: new Set(['0-p0', '1-p0']),
});
assert.match(cropNormalized.markdown, /!\[Research model\]\(\/api\/media\/asset\/pdf-crops\/a{64}\/0-p0\.png\)/u);
assert.match(cropNormalized.markdown, /!\[Visible cues Social inferences Representative quote\]/u);
assert.equal(cropNormalized.sourceCrops.length, 2);

console.info({
	event: 'zotero_sdt_contract_passed',
	markdownCharacters: normalized.markdown.length,
	mentions: normalized.mentions.length,
	references: normalized.references.length,
});
