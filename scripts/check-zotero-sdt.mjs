import assert from 'node:assert/strict';
import { fromHtml } from 'hast-util-from-html';
import { fromMarkdown as parseMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { expandHtmlTables } from '../src/ingest/html-table.ts';
import { withoutDuplicatePdfTitle } from '../src/ingest/pdf-markdown.ts';
import {
	hasPrivatePdfImages,
	matchesUploadedPdfRendition,
	withoutPrivatePdfImages,
	normalizeStructuredPdf,
	parseStructuredPdfDocumentJson,
	parseStructuredPdfFailure,
	structuredPdfSourceCrops,
	structuredPdfSourceCropUrl,
	structuredPdfStorageKey,
	structuredPdfVisualPlan,
} from '../src/ingest/zotero-sdt.ts';

const fromMarkdown = (source, options = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) => parseMarkdown(source, options);
const htmlElements = (source, tagName) => {
	const elements = [];
	const visit = (node) => {
		if (node.type === 'element' && node.tagName === tagName) elements.push(node);
		if ('children' in node) node.children.forEach(visit);
	};
	visit(fromHtml(source, { fragment: true }));
	return elements;
};
const htmlText = (node) => node.value ?? node.children?.map(htmlText).join('') ?? '';

const text = (value, options = {}) => ({
	anchor: { pageRects: [[0, 10, 10, 20, 20]], textMap: JSON.stringify([[0, 0, 0, value.length, 10, 10, 20, 20]]) },
	text: value,
	...options,
});

const document = {
	catalog: {
		outline: [
			{ ref: [1], title: 'Introduction', children: [{ ref: [1], title: 'Duplicate outline target' }] },
			{ ref: [4], title: 'References' },
		],
		pages: [{ contentRange: [[0], [4]], textSource: 'born-digital' }],
	},
	content: [
		{ content: [text('')], type: 'paragraph' },
		{ content: [text('Introduction')], type: 'heading' },
		{
			content: [
				text('Prior work reported t '),
				text('(', { refs: [[4, 0]] }),
				text('46', { refs: [[4, 0]], style: { monospace: true } }),
				text(')', { refs: [[4, 0]] }),
				text(', F '),
				text('(', { refs: [[4, 0]] }),
				text('1', { refs: [[4, 0]], style: { monospace: true } }),
				text(',', { refs: [[4, 0]] }),
				text(' ', { refs: [[4, 0]] }),
				text('44', { refs: [[4, 0]], style: { monospace: true } }),
				text(')', { refs: [[4, 0]] }),
				text(' and '),
				text('[1]', { refs: [[4, 0]] }),
			],
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

const noteDocument = {
	...document,
	catalog: { ...document.catalog, outline: [] },
	content: [
		{
			type: 'paragraph',
			content: [
				text('A claim'),
				text('1', { refs: [[1]], style: { sup: true } }),
				text(' and again'),
				text('1', { refs: [[1]] }),
				text('.'),
			],
		},
		{ type: 'note', flowClass: 'auxiliary', content: [text('1 The qualifying note.')] },
		{ type: 'note', content: [text('An unlinked table note.')] },
	],
};
const noted = normalizeStructuredPdf(noteDocument);
assert.match(noted.markdown, /A claim\[\^sdt-note-1\] and again\[\^sdt-note-1\]/u);
assert.match(noted.markdown, /\[\^sdt-note-1\]: The qualifying note\./u);
assert.match(noted.markdown, /An unlinked table note\./u);
assert.equal(noted.references.length, 0, 'explanatory notes are not bibliography entries');

const frontMatterDocument = {
	...document,
	catalog: { ...document.catalog, outline: [{ title: 'Introduction', ref: [2] }] },
	content: [
		{ type: 'heading', content: [text('A useful paper')] },
		{ type: 'heading', content: [text('Alex Example', { target: { url: 'https://orcid.org/0000-0000-0000-0001' } })] },
		{ type: 'heading', content: [text('Introduction')] },
		{ type: 'paragraph', content: [text('The body.')] },
	],
};
const frontMatterMarkdown = normalizeStructuredPdf(frontMatterDocument).markdown;
assert.doesNotMatch(frontMatterMarkdown, /^## \[Alex Example\]/mu);
assert.match(frontMatterMarkdown, /^## Introduction/mu);
assert.doesNotMatch(withoutDuplicatePdfTitle(frontMatterMarkdown, 'A useful paper'), /^## A useful paper/mu);
assert.equal(withoutDuplicatePdfTitle(frontMatterMarkdown, 'Different title'), frontMatterMarkdown);
assert.equal(withoutDuplicatePdfTitle('# Only title', 'Only title'), '# Only title');
assert.equal(withoutDuplicatePdfTitle('## **Actual** title\n\nBody.', 'Actual title'), 'Body.');

assert.equal(normalized.references.length, 1);
assert.deepEqual(normalized.references[0], {
	key: 'sdt-1',
	label: '1',
	text: 'Example, A. A useful paper. Journal 1 (2024). https://doi.org/10.1000/example',
});
assert.equal(normalized.mentions.length, 1);
assert.deepEqual(normalized.mentions[0].targetKeys, ['sdt-1']);
assert.match(normalized.markdown, /\[\^paper-sdt-1\]/u);
assert.match(normalized.mentions[0].context, /Prior work reported t \(46\), F \(1, 44\) and \[1\] established the result2\./u);
assert.equal(normalized.mentions[0].section, 'Introduction');
assert.doesNotMatch(normalized.markdown, /Running header|<sup>|<sub>/u);
assert.doesNotMatch(normalized.markdown, /`46`/u);
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

const formattedDocument = {
	...document,
	content: [
		{
			type: 'table',
			content: [
				{
					type: 'tablerow',
					content: [
						{ type: 'tablecell', content: [text('A | B')] },
						{ type: 'tablecell', content: ['one', 'two'].map((value) => ({ type: 'paragraph', content: [text(value)] })) },
					],
				},
			],
		},
		{ type: 'preformatted', content: [text('before\n```\nafter')] },
	],
};
const formatted = fromMarkdown(normalizeStructuredPdf(formattedDocument).markdown, {
	extensions: [gfm()],
	mdastExtensions: [gfmFromMarkdown()],
}).children;
assert.deepEqual(
	formatted.map(({ type }) => type),
	['html', 'code'],
);
const formattedCells = htmlElements(formatted[0].value, 'td');
assert.equal(formattedCells.length, 2);
assert.equal(htmlText(formattedCells[0]), 'A | B');
assert.deepEqual(formattedCells[1].children.filter((node) => node.type === 'element').map(htmlText), ['one', 'two']);
assert.equal(formatted[1].value, 'before\n```\nafter');

const tableCell = (value, properties = {}) => ({
	type: 'tablecell',
	...properties,
	content: [{ type: 'paragraph', content: [text(value)] }],
});
const tableRow = (...content) => ({ type: 'tablerow', content });
const tableMarkdown = (...content) => normalizeStructuredPdf({ ...document, content: [{ type: 'table', content }] }).markdown;
const simpleTable = fromMarkdown(
	tableMarkdown(
		tableRow(tableCell('Group', { header: true, axis: 'column' }), tableCell('Measure', { header: true, axis: 'column' })),
		tableRow(tableCell('A'), tableCell('42')),
	),
).children[0];
assert.equal(simpleTable.type, 'table');
assert.deepEqual(
	simpleTable.children.map((row) => row.children.map((cell) => cell.children.map((node) => node.value).join(''))),
	[
		['Group', 'Measure'],
		['A', '42'],
	],
);
const headlessTable = fromMarkdown(tableMarkdown(tableRow(tableCell('A', { header: false }), tableCell('42')))).children[0];
assert.equal(headlessTable.type, 'table');
assert.equal(headlessTable.children.length, 2, 'a headless table gets an empty GFM header, never promotes its first data row');
assert.ok(headlessTable.children[0].children.every((cell) => cell.children.length === 0));
assert.deepEqual(
	headlessTable.children[1].children.map((cell) => cell.children[0].value),
	['A', '42'],
);
const mixedTable = tableMarkdown(tableRow(tableCell('Group', { header: true }), tableCell('A', { header: false })));
assert.equal(htmlElements(mixedTable, 'th').length, 1);
assert.equal(htmlElements(mixedTable, 'td').length, 1);
const semanticTable = tableMarkdown(
	tableRow(
		tableCell('Group', { header: true, axis: 'row', rowspan: 2 }),
		tableCell('Measures', { header: true, axis: 'column', colspan: 2 }),
	),
	tableRow(tableCell('42'), tableCell('81'), tableCell('Discarded', { flowClass: 'excluded' })),
);
assert.deepEqual(
	htmlElements(semanticTable, 'th').map(({ properties }) => properties),
	[
		{ scope: 'row', rowSpan: 2 },
		{ scope: 'col', colSpan: 2 },
	],
);
assert.deepEqual(htmlElements(semanticTable, 'td').map(htmlText), ['42', '81']);
assert.doesNotMatch(semanticTable, /Discarded/u);

const prose = (...content) => ({ type: 'paragraph', content });
const cite = () => text('[1]', { refs: [[1]] });
const nestedDocument = {
	...document,
	catalog: { ...document.catalog, outline: [{ title: 'Nested heading', ref: [0, 1, 0, 0] }] },
	content: [
		{
			type: 'blockquote',
			content: [
				prose(text('Quoted 😀 '), cite()),
				{
					type: 'list',
					ordered: true,
					startIndex: 10,
					content: [
						{
							type: 'listitem',
							content: [
								{ type: 'heading', content: [text('Nested heading')] },
								prose(text('First paragraph '), cite()),
								prose(text('Second paragraph '), cite()),
								{ type: 'list', content: [{ type: 'listitem', content: [text('Child '), cite()] }] },
							],
						},
					],
				},
			],
		},
		{ type: 'paragraph', reference: true, content: [text('[1] Example reference.')] },
	],
};
const nested = normalizeStructuredPdf(nestedDocument);
const quote = fromMarkdown(nested.markdown).children[0];
assert.equal(quote.type, 'blockquote');
const list = quote.children[1];
assert.equal(list.type, 'list');
assert.equal(list.start, 10);
assert.deepEqual(
	list.children[0].children.map(({ type }) => type),
	['heading', 'paragraph', 'paragraph', 'list'],
);
assert.equal(nested.mentions.length, 4);
assert.equal(nested.mentions[0].section, null);
for (const mention of nested.mentions.slice(1)) assert.equal(mention.section, 'Nested heading');
assert.match(nested.markdown, /\[\^paper-sdt-1\]:/u);

const nestedParts = structuredClone(nestedDocument);
const itemParts = nestedParts.content[0].content[1].content[0].content;
itemParts[1].content.push(text(' '));
itemParts[1].nextPart = [0, 1, 0, 2];
itemParts[2].previousPart = [0, 1, 0, 1];
const joinedNested = normalizeStructuredPdf(nestedParts);
assert.match(joinedNested.markdown, /First paragraph \[\^paper-sdt-1\] Second paragraph \[\^paper-sdt-1\]/u);
assert.equal(joinedNested.mentions.length, 4);
assert.match(joinedNested.markdown, /\[\^paper-sdt-1\]:/u);

// Part links must not duplicate text or move it between independent containers.
for (const [content, expected] of [
	[
		[
			{ ...prose(text('First')), nextPart: [2] },
			{ ...prose(text('Second')), nextPart: [2] },
			{ ...prose(text('shared.')), previousPart: [0] },
		],
		'First shared.\n\nSecond',
	],
	[
		[
			{ type: 'blockquote', content: [{ ...prose(text('Inside')), nextPart: [1] }] },
			{ ...prose(text('Outside')), previousPart: [0, 0] },
		],
		'> Inside\n\nOutside',
	],
]) {
	assert.equal(normalizeStructuredPdf({ ...document, content }).markdown, expected);
}

// Hidden and empty references must not become durable bibliography/mention data.
for (const reference of [
	{ ...prose(text('Hidden reference')), reference: true, flowClass: 'excluded' },
	{ type: 'blockquote', flowClass: 'excluded', content: [{ ...prose(text('Hidden reference')), reference: true }] },
	{ ...prose(text('')), reference: true },
]) {
	const target = reference.type === 'blockquote' ? [1, 0] : [1];
	const result = normalizeStructuredPdf({ ...document, content: [prose(text('See '), text('[1]', { refs: [target] })), reference] });
	assert.deepEqual(result.references, []);
	assert.deepEqual(result.mentions, []);
	assert.equal(fromMarkdown(result.markdown).children[0].children[0].value, 'See [1]');
}

const hiddenContinuation = normalizeStructuredPdf({
	...document,
	content: [
		{ ...prose(text('[1] Visible reference.')), reference: true, nextPart: [1, 0] },
		{
			type: 'blockquote',
			flowClass: 'excluded',
			content: [{ ...prose(text('Hidden continuation')), reference: true, previousPart: [0] }],
		},
	],
});
assert.deepEqual(hiddenContinuation.references, [{ key: 'sdt-1', label: '1', text: 'Visible reference.' }]);

let deepBlock = prose(text('Nested'));
for (let depth = 0; depth < 100; depth += 1) deepBlock = { type: 'blockquote', content: [deepBlock] };
assert.throws(() => parseStructuredPdfDocumentJson(JSON.stringify({ ...document, content: [deepBlock] })), /depth/u);

const formatting = normalizeStructuredPdf({
	...document,
	content: [
		...['# Literal heading', '- Literal bullet', '1. Literal number', '<script>alert(1)</script>'].map((value) => prose(text(value))),
		prose(text('em', { style: { italic: true } }), text('phasis', { style: { italic: true } })),
		prose(text('left'), text(' bold ', { style: { bold: true } }), text('right')),
		// oxlint-disable-next-line eslint/no-script-url -- Verify rejection of malicious provider links.
		prose(text('unsafe', { target: { url: 'javascript:alert(1)' } })),
		prose(text('credentials', { target: { url: 'https://user:pass@example.com' } })),
		prose(text('safe', { target: { url: 'https://example.com/a_(b)' } })),
	],
});
const formattedProse = fromMarkdown(formatting.markdown).children;
assert.ok(formattedProse.every(({ type }) => type === 'paragraph'));
assert.equal(formattedProse[0].children[0].value, '# Literal heading');
assert.equal(formattedProse[3].children[0].value, '<script>alert(1)</script>');
assert.equal(formattedProse[4].children[0].type, 'emphasis');
assert.equal(formattedProse[4].children[0].children[0].value, 'emphasis');
assert.equal(formattedProse[5].children[1].type, 'strong');
assert.equal(formattedProse[5].children[1].children[0].value, ' bold ');
assert.equal(formattedProse[6].children[0].type, 'text');
assert.equal(formattedProse[7].children[0].type, 'text');
assert.equal(formattedProse[8].children[0].url, 'https://example.com/a_(b)');

// PDF glyph runs may switch between italic and bold-italic without a space.
// Round-trip visible text, not a particular choice of Markdown delimiters.
const visibleText = (node) => (node.type === 'footnoteReference' ? '[1]' : (node.value ?? (node.children ?? []).map(visibleText).join('')));
const styles = [{}, { bold: true }, { italic: true }, { bold: true, italic: true }];
for (const type of ['paragraph', 'caption']) {
	for (const left of styles) {
		for (const right of styles) {
			const styled = normalizeStructuredPdf({
				...document,
				content: [
					{ type, content: [text('one', { style: left }), text(' two* ', { style: right }), cite()] },
					{ type: 'paragraph', reference: true, content: [text('[1] Example.')] },
				],
			});
			assert.equal(visibleText(fromMarkdown(styled.markdown).children[0]), 'one two* [1]');
			assert.equal(styled.mentions.length, 1);
			assert.match(styled.markdown, /\[\^paper-sdt-1\]:/u);
		}
	}
}

// Table cells must retain readable content and native citations through the same
// block normalization as the body, without leaking cell headings into its section.
const tableCite = () => text('[1]', { refs: [[2]] });
const richTableDocument = {
	...document,
	content: [
		{ type: 'heading', content: [text('Results')] },
		{
			type: 'table',
			content: [
				{
					type: 'tablerow',
					content: [
						{
							type: 'tablecell',
							content: [
								{ ...prose(text('First ', { style: { italic: true } }), tableCite()), nextPart: [1, 0, 0, 1] },
								{ ...prose(text(' continuation', { style: { bold: true } })), previousPart: [1, 0, 0, 0] },
								{ ...prose(text('Excluded')), flowClass: 'excluded' },
								{ type: 'blockquote', content: [prose(text('Quote')), { ...prose(text('Hidden')), flowClass: 'excluded' }] },
							],
						},
						{
							type: 'tablecell',
							content: [
								{ type: 'heading', content: [text('Cell heading')] },
								prose(text('A | B '), text('source', { target: { url: 'https://example.com/table' } }), text(' '), tableCite()),
								{ type: 'list', content: [{ type: 'listitem', content: [prose(text('One')), prose(text('Two'))] }] },
							],
						},
					],
				},
			],
		},
		{ ...prose(text('[1] Example reference.')), reference: true },
		prose(text('After table '), tableCite()),
	],
};
const richTable = normalizeStructuredPdf(richTableDocument);
const richCells = htmlElements(richTable.markdown, 'td');
assert.equal(richCells.length, 2);
assert.match(htmlText(richCells[0]), /First \[\^paper-sdt-1\] continuation\s*Quote/u);
assert.match(htmlText(richCells[1]), /Cell heading\s*A \| B source \[\^paper-sdt-1\]\s*One\s*Two/u);
assert.equal(htmlElements(richTable.markdown, 'em').length, 1);
assert.equal(htmlElements(richTable.markdown, 'strong').length, 1);
assert.equal(htmlElements(richTable.markdown, 'blockquote').length, 1);
assert.equal(htmlElements(richTable.markdown, 'ul').length, 1);
assert.ok(htmlElements(richTable.markdown, 'a').some(({ properties }) => properties.href === 'https://example.com/table'));
assert.doesNotMatch(richTable.markdown, /Excluded|Hidden/u);
assert.deepEqual(
	richTable.mentions.map(({ section }) => section),
	['Results', 'Cell heading', 'Results'],
);
assert.match(richTable.markdown, /\[\^paper-sdt-1\]:/u);
assert.doesNotMatch(richTable.markdown, /#sdt-citation-/u);

const pipeMarkerDocument = structuredClone(richTableDocument);
pipeMarkerDocument.content[1].content[0].content[0].content[0].content[1].text = '[A|B]';
const pipeMarkerTable = normalizeStructuredPdf(pipeMarkerDocument);
const pipeCells = htmlElements(pipeMarkerTable.markdown, 'td');
assert.match(htmlText(pipeCells[0]), /First \[\^paper-sdt-1\] continuation\s*Quote/u);
assert.equal(pipeMarkerTable.mentions.length, 3);

const complexNoteDocument = structuredClone(noteDocument);
complexNoteDocument.content[0] = {
	type: 'table',
	content: [
		tableRow(
			{
				type: 'tablecell',
				colspan: 2,
				content: [prose(text('A claim'), text('1', { refs: [[1]] })), { type: 'preformatted', content: [text('if (a < b) return `x`;')] }],
			},
			{ type: 'tablecell', flowClass: 'excluded', content: [prose(text('Hidden note'), text('1', { refs: [[1]] }))] },
		),
	],
};
const complexNoteTable = normalizeStructuredPdf(complexNoteDocument).markdown;
assert.match(complexNoteTable, /A claim\[\^sdt-note-1\]/u);
assert.match(complexNoteTable, /\[\^sdt-note-1\]: The qualifying note\./u);
assert.equal(htmlText(htmlElements(complexNoteTable, 'code')[0]).trimEnd(), 'if (a < b) return `x`;');
assert.equal(htmlElements(complexNoteTable, 'td').length, 1);
assert.doesNotMatch(complexNoteTable, /Hidden note/u);
const simpleNoteDocument = structuredClone(complexNoteDocument);
simpleNoteDocument.content[0].content[0].content = [
	{
		type: 'tablecell',
		content: [prose(text('A claim'), text('1', { refs: [[1]] }))],
	},
];
const simpleNoteTable = normalizeStructuredPdf(simpleNoteDocument).markdown;
assert.match(simpleNoteTable, /A claim\[\^sdt-note-1\]/u);
assert.equal(fromMarkdown(simpleNoteTable).children[0].children[1].children[0].children[1].type, 'footnoteReference');

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

const splitReferenceDocument = JSON.parse(JSON.stringify(document));
splitReferenceDocument.catalog.pages = [{ contentRange: [[0], [5]], textSource: 'born-digital' }];
splitReferenceDocument.content[2].content = [text('Prior work '), text('[41]', { refs: [[5]] })];
splitReferenceDocument.content[4] = paragraph('[41] Kane, G.C.; Alavi, M.;', [[0, 54, 80, 295, 120]], {
	nextPart: [5],
	reference: true,
});
splitReferenceDocument.content.push(
	paragraph('and Borgatti, S.P. A complete reference. MIS Quarterly (2014).', [[0, 317, 700, 558, 735]], {
		previousPart: [4],
		reference: true,
	}),
);
const splitReferenceNormalized = normalizeStructuredPdf(parseStructuredPdfDocumentJson(JSON.stringify(splitReferenceDocument)));
assert.deepEqual(splitReferenceNormalized.references, [
	{
		key: 'sdt-1',
		label: '41',
		text: 'Kane, G.C.; Alavi, M.;and Borgatti, S.P. A complete reference. MIS Quarterly (2014).',
	},
]);
assert.deepEqual(splitReferenceNormalized.mentions[0].targetKeys, ['sdt-1']);
assert.equal(splitReferenceNormalized.mentions[0].markerText, '[41]');

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
const sourceCrops = structuredPdfSourceCrops(parsedCropDocument);
assert.deepEqual(
	sourceCrops.map(({ blockPath, pageIndex, rect }) => ({
		blockPath,
		pageIndex,
		rect,
	})),
	[
		{ blockPath: '0', pageIndex: 0, rect: [20, 40, 220, 180] },
		{ blockPath: '1', pageIndex: 0, rect: [30, 200, 260, 500] },
	],
);
const cropWithoutManifest = normalizeStructuredPdf(parsedCropDocument, { inputContentHash: 'a'.repeat(64) });
assert.doesNotMatch(cropWithoutManifest.markdown, /\/api\/media\/asset\/pdf-crops/u);
const partiallyReadyCrop = normalizeStructuredPdf(parsedCropDocument, {
	inputContentHash: 'a'.repeat(64),
	readySourceCrops: sourceCrops.slice(0, 1),
});
assert.match(partiallyReadyCrop.markdown, /\/0-p0-[a-f\d]{16}\.png/u);
assert.doesNotMatch(partiallyReadyCrop.markdown, /\/1-p0-[a-f\d]{16}\.png/u);
const cropNormalized = normalizeStructuredPdf(parsedCropDocument, {
	inputContentHash: 'a'.repeat(64),
	readySourceCrops: sourceCrops,
});
assert.match(cropNormalized.markdown, /!\[Research model\]\(\/api\/media\/asset\/pdf-crops\/a{64}\/0-p0-[a-f\d]{16}\.png\)/u);
assert.match(cropNormalized.markdown, /!\[Visible cues Social inferences Representative quote\]/u);

// Caption geometry recovers raster/vector figures without converting an author grid
// into images, swallowing prose, or losing the caption when crops are ready.
const anchored = (type, value, page, rect, extra = {}) => ({
	type,
	anchor: { pageRects: [[page, ...rect]] },
	content: [{ text: value, anchor: { textMap: JSON.stringify([[0, page, ...rect, 4]]) } }],
	...extra,
});
const visualDocument = {
	...document,
	catalog: { outline: [], pages: [0, 1, 2].map(() => ({ viewRect: [0, 0, 612, 792], contentRange: [[0], [13]] })) },
	content: [
		anchored('heading', 'An example research paper', 0, [54, 700, 558, 720]),
		anchored('table', 'University of Example', 0, [54, 580, 250, 595]),
		anchored('table', 'alice@example.edu', 0, [54, 560, 250, 575]),
		anchored('table', 'Institute of Example', 0, [318, 580, 558, 595]),
		anchored('table', 'bob@example.edu', 0, [318, 560, 558, 575]),
		anchored('caption', 'Figure 1: A diagram without an SDT image node.', 0, [54, 300, 558, 330]),
		anchored('heading', 'Abstract', 0, [54, 270, 250, 285]),
		anchored('table', 'Group Measure 1 42 2 81', 0, [54, 100, 558, 240]),
		// Upstream incorrectly includes graphics in this excluded running-header block.
		{
			...anchored('paragraph', 'Running header', 1, [54, 723, 558, 729], { flowClass: 'excluded' }),
			anchor: { pageRects: [[1, 54, 450, 558, 729]] },
		},
		anchored('caption', 'Figure 2: A single-column screenshot.', 1, [54, 370, 294, 430]),
		anchored('paragraph', 'Unrelated right-column prose must remain outside the recovered image.', 1, [318, 430, 558, 705]),
		anchored('caption', 'The preceding graphic caption.', 2, [54, 425, 558, 473]),
		{
			...anchored('paragraph', '12345 Cocoa Baseline Steerability', 2, [54, 291, 558, 410]),
			content: [
				{
					text: '12345 Cocoa Baseline Steerability',
					anchor: {
						textMap: JSON.stringify([
							[0, 2, 88, 291, 217, 303, 4],
							[0, 2, 65, 367, 86, 379, 4],
							[0, 2, 132, 395, 184, 410, 4],
						]),
					},
				},
			],
		},
		anchored('caption', 'Figure 9: Ratings across the two conditions.', 2, [54, 256, 558, 274]),
	],
};
const visualPlan = structuredPdfVisualPlan(visualDocument);
assert.equal(visualPlan.excludedAuthorTables.length, 4);
assert.ok(
	visualPlan.crops.some(({ blockPath }) => blockPath === '7'),
	'the real data table stays renderable',
);
for (const figureId of ['Figure 1', 'Figure 2', 'Figure 9']) {
	assert.equal(visualPlan.crops.filter((crop) => crop.figureId === figureId).length, 1);
}
const narrowFigure = visualPlan.crops.find(({ figureId }) => figureId === 'Figure 2');
assert.ok(narrowFigure.rect[2] < 318, 'single-column crop cannot include adjacent prose');
assert.ok(narrowFigure.rect[3] < 723, 'excluded header remains outside the image');
assert.ok(visualPlan.crops.find(({ figureId }) => figureId === 'Figure 1').rect[3] < 560, 'author metadata remains outside the image');
const visualReady = normalizeStructuredPdf(visualDocument, {
	inputContentHash: 'b'.repeat(64),
	readySourceCrops: visualPlan.crops,
	cropUrlPrefix: '/api/media/asset/public-pdf-crops/example-source',
});
assert.match(visualReady.markdown, /alice\\?@example\.edu/u);
assert.match(visualReady.markdown, /bob\\?@example\.edu/u);
assert.match(visualReady.markdown, /Unrelated right-column prose/u);
assert.match(visualReady.markdown, /_Figure 9: Ratings across the two conditions\._/u);
assert.doesNotMatch(visualReady.markdown, /12345 Cocoa Baseline Steerability/u);
assert.match(visualReady.markdown, /\/public-pdf-crops\/example-source\/b{64}\//u);
assert.equal(visualReady.parse.visual.inferred, 3);
assert.ok(visualReady.parse.fallbackReasons.includes('caption-region-inferred'));
const chartUnavailable = normalizeStructuredPdf(visualDocument, {
	inputContentHash: 'b'.repeat(64),
	readySourceCrops: visualPlan.crops.filter(({ figureId }) => figureId !== 'Figure 9'),
});
assert.match(chartUnavailable.markdown, /12345 Cocoa Baseline Steerability/u);
assert.ok(chartUnavailable.parse.visual.missing.some(({ figureId, reason }) => figureId === 'Figure 9' && reason === 'crop-not-ready'));
assert.ok(chartUnavailable.parse.fallbackReasons.includes('incomplete-visuals'));
const obstructedDocument = {
	...visualDocument,
	content: [...visualDocument.content, anchored('paragraph', 'Prose crossing the candidate region.', 1, [54, 425, 294, 490])],
};
const obstructed = structuredPdfVisualPlan(obstructedDocument);
assert.ok(!obstructed.crops.some(({ figureId }) => figureId === 'Figure 2'));
assert.ok(obstructed.missing.some(({ figureId, reason }) => figureId === 'Figure 2' && reason === 'region-overlaps-text'));
const changedGeometry = structuredClone(visualDocument);
changedGeometry.content[9].anchor.pageRects[0][4] += 5;
assert.notEqual(structuredPdfVisualPlan(changedGeometry).crops.find(({ figureId }) => figureId === 'Figure 2').id, narrowFigure.id);
const changedProcessor = structuredClone(visualDocument);
changedProcessor.metadata.processor.version += 1;
assert.notEqual(structuredPdfVisualPlan(changedProcessor).crops.find(({ figureId }) => figureId === 'Figure 2').id, narrowFigure.id);

const oversizedVisuals = structuredPdfVisualPlan({
	...visualDocument,
	content: Array.from({ length: 65 }, (_, index) => anchored('image', `Image ${index}`, 0, [54, 500, 558, 700])),
});
assert.equal(oversizedVisuals.crops.length, 64);
assert.ok(oversizedVisuals.missing.some(({ reason }) => reason === 'crop-budget-exceeded'));
const unavailableGeometry = structuredPdfVisualPlan({
	...visualDocument,
	content: [{ type: 'image', content: [] }, anchored('caption', 'Figure 4: Invalid page.', 100, [54, 300, 558, 320])],
});
assert.ok(unavailableGeometry.missing.some(({ reason }) => reason === 'graphic-geometry-unavailable'));
assert.ok(unavailableGeometry.missing.some(({ reason }) => reason === 'caption-page-unavailable'));
assert.equal(
	structuredPdfVisualPlan({
		...visualDocument,
		content: [anchored('caption', 'Figure 9: Excluded caption.', 0, [54, 300, 558, 320], { flowClass: 'excluded' })],
	}).crops.length,
	0,
);

console.info({
	event: 'zotero_sdt_contract_passed',
	markdownCharacters: normalized.markdown.length,
	mentions: normalized.mentions.length,
	references: normalized.references.length,
});

// Public/private body projection is part of the normalized PDF contract.
{
	const privateUrl = `/api/media/asset/pdf-crops/${'a'.repeat(64)}/12-p3-1234567890abcdef.png`;
	const publicUrl = `/api/media/asset/public-pdf-crops/${'b'.repeat(64)}/${'a'.repeat(64)}/12-p3-1234567890abcdef.png`;
	const source = `# Paper\n\nBefore ![private figure](${privateUrl}) after.\n\n![public figure](${publicUrl})\n\nFigure 1. Caption.\n\n\`![example](${privateUrl})\``;
	const projected = withoutPrivatePdfImages(source);
	assert.equal(projected, source.replace(`![private figure](${privateUrl})`, ''));
	assert.equal(hasPrivatePdfImages(source), true);
	assert.equal(hasPrivatePdfImages(projected), false);
	assert.equal(withoutPrivatePdfImages(projected), projected, 'Public projection must be idempotent');
	assert.equal(withoutPrivatePdfImages(`![Figure][crop]\n\n[crop]: ${privateUrl}`), '');
	assert.equal(withoutPrivatePdfImages(`![Figure](https://newsence.app${privateUrl})\n\nCaption`), 'Caption');
	assert.equal(withoutPrivatePdfImages('No images.\n\n$x=y$'), 'No images.\n\n$x=y$');
	assert.equal(matchesUploadedPdfRendition(projected, source), true);
	assert.equal(matchesUploadedPdfRendition(source, source), true);
	assert.equal(matchesUploadedPdfRendition('A different published version and bibliography.', source), false);
	console.info('PDF private/public rendition contract checks passed');
}

// Stored footnote identifiers survive image removal and repeated/grouped citations.
{
	const notes = (markdown) => {
		const definitions = [];
		const references = [];
		const visit = (node) => {
			if (node.type === 'footnoteDefinition') definitions.push(node.identifier);
			if (node.type === 'footnoteReference') references.push(node.identifier);
			for (const child of node.children ?? []) visit(child);
		};
		visit(expandHtmlTables(fromMarkdown(markdown)));
		return { definitions, references };
	};
	for (const result of [normalized, nested, richTable]) {
		const actual = notes(result.markdown);
		assert.equal(actual.definitions.length, new Set(actual.definitions).size);
		assert.equal(
			actual.references.length,
			result.mentions.reduce((total, mention) => total + mention.targetKeys.length, 0),
		);
		assert.ok(actual.references.every((id) => actual.definitions.includes(id)));
		const withImage = `![Figure](/api/media/asset/pdf-crops/example.png)\n\n${result.markdown}`;
		assert.deepEqual(notes(withoutPrivatePdfImages(withImage)), actual);
	}
}
