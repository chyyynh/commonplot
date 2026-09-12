import assert from 'node:assert/strict';
import { fromHtml } from 'hast-util-from-html';
import { fromMarkdown as parseMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { hasPrivatePdfImages, withoutPrivatePdfImages, withoutDuplicatePdfTitle } from '../src/ingest/pdf-markdown.ts';
import { normalizeStructuredPdf, parseStructuredPdfDocumentJson, structuredPdfVisualPlan } from '../src/ingest/zotero-sdt.ts';

const fromMarkdown = (source, options = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) => parseMarkdown(source, options);
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
assert.match(normalized.markdown, /\[\^paper-sdt-1\]/u);
assert.doesNotMatch(normalized.markdown, /Running header|<sup>|<sub>/u);
assert.doesNotMatch(normalized.markdown, /`46`/u);
assert.match(normalized.markdown, /^## Introduction/u);
assert.match(normalized.paperIdentifierText ?? '', /DOI: 10\.1000\/example/u);
assert.equal(normalized.parse.totalPages, 1);
assert.equal(normalized.parse.fullPageImagePages, 0);

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
const visualReadyCrops = visualPlan.crops.map((crop) => ({
	...crop,
	url: `/api/media/asset/public-pdf-crops/example-source/${'b'.repeat(64)}/${crop.id}.png`,
}));
const visualReady = normalizeStructuredPdf(visualDocument, { visualPlan, readySourceCrops: visualReadyCrops });
assert.match(visualReady.markdown, /alice\\?@example\.edu/u);
assert.match(visualReady.markdown, /bob\\?@example\.edu/u);
assert.match(visualReady.markdown, /Unrelated right-column prose/u);
assert.match(visualReady.markdown, /_Figure 9: Ratings across the two conditions\._/u);
assert.doesNotMatch(visualReady.markdown, /12345 Cocoa Baseline Steerability/u);
assert.match(visualReady.markdown, /\/public-pdf-crops\/example-source\/b{64}\//u);
assert.equal(visualReady.parse.visual.inferred, 3);
assert.ok(visualReady.parse.fallbackReasons.includes('caption-region-inferred'));
const chartUnavailable = normalizeStructuredPdf(visualDocument, {
	visualPlan,
	readySourceCrops: visualReadyCrops.filter(({ figureId }) => figureId !== 'Figure 9'),
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
	console.info('PDF private/public rendition contract checks passed');
}

import { normalizeExtractedPdfMarkdown as normalize } from '../src/ingest/extracted-pdf-markdown.ts';

const samples = [];
function normalizeSample(source) {
	const result = normalize(source);
	assert.equal(normalize(result), result, 'Normalization must be idempotent');
	samples.push(result);
	return result;
}
function nodes(node) {
	return [node, ...('children' in node ? node.children.flatMap(nodes) : [])];
}
function parse(source) {
	return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

assert.equal(normalizeSample('Uses [<u>[4, 5, 40]</u>] and reigniting<sup>1</sup>.'), 'Uses [4, 5, 40] and reigniting1.');
assert.equal(
	normalizeSample('<th colspan="2">Participation and <Cyan released>, but keep <T>.'),
	'Participation and Cyan released, but keep &lt;T&gt;.',
);
assert.equal(
	normalizeSample('See <Mattern (2020)</Mattern> and <sagepub.com/journals-permissions>.'),
	'See Mattern (2020) and [sagepub.com/journals-permissions](https://sagepub.com/journals-permissions).',
);

const preserved = [
	'```html\n<table><tr><td><u>code</u></td></tr></table>\n```',
	'    <u>Indented code</u>',
	'Tags and </\n\n```\nall steps> tags, between <problem> and </problem>\n```',
	'`Keep <u>code</u>` and ``x ` <sup>2</sup>``',
	'$x < y$ and $$<u>x</u>$$',
	'$$\n\\text{<u>math</u>}\n$$',
	'[source](https://example.com?a=1&b=2 "<u>title</u>") and <https://example.com>',
	'![<u>image description</u>](https://example.com/image.png)',
	'An existing note[^existing].\n\n[^existing]: Footnote body with `code`.',
	'[reference][source]\n\n[source]: https://example.com "<u>title</u>"',
	'\\<u>Escaped HTML\\</u> and &lt;u&gt;escaped entities&lt;/u&gt;',
];
for (const source of preserved) assert.equal(normalizeSample(source), source);
assert.equal(normalizeSample('<u>A `keep <u>x</u>`</u>'), 'A `keep <u>x</u>`');
assert.equal(normalizeSample('Note[^one].\n\n[^one]: <u>Details</u>.'), 'Note[^one].\n\n[^one]: Details.');

const simple = normalizeSample(
	'<table><thead><tr><th>Time</th><th>Result</th></tr></thead><tbody><tr><td>Day 1</td><td><b>42</b> <a href="https://example.com">source</a></td></tr></tbody></table>',
);
const simpleTree = parse(simple);
assert.equal(simpleTree.children[0].type, 'table');
assert.ok(nodes(simpleTree).some((node) => node.type === 'strong'));
assert.ok(nodes(simpleTree).some((node) => node.type === 'link' && node.url === 'https://example.com'));
assert.doesNotMatch(simple, /<table>/u);

const mixed = normalizeSample(
	'<table><tr><th>Result</th></tr><tr><td>**bold** [source](https://example.com) $x$ [^one] `a | b <u>c</u>`</td></tr></table>\n\n[^one]: Original note',
);
assert.ok(nodes(parse(mixed)).some((node) => node.type === 'footnoteReference' && node.identifier === 'one'));
assert.ok(nodes(parse(mixed)).some((node) => node.type === 'link' && node.url === 'https://example.com'));
assert.ok(nodes(parse(mixed)).some((node) => node.type === 'inlineCode' && node.value === 'a | b <u>c</u>'));
assert.match(mixed, /\$x\$/u);
assert.match(mixed, /\*\*bold\*\*/u);
const headless = parse(normalizeSample('<table><tr><td>First data row</td><td>42</td></tr></table>')).children[0];
assert.equal(headless.children.length, 2, 'A headless table must retain its first data row below an empty GFM header');

const merged = normalizeSample(
	'<table class="provider"><tr><th colspan="2" style="color:red">Heading</th></tr><tr><td rowspan="2"><b>42</b></td><td><a href="https://example.com" onclick="bad()">source</a><br>Next</td></tr></table>',
);
assert.match(merged, /colspan="2"/u);
assert.match(merged, /rowspan="2"/u);
assert.match(merged, /<strong>42<\/strong>/u);
assert.match(merged, /<a href="https:\/\/example.com">source<\/a><br>Next/u);
assert.doesNotMatch(merged, /class=|style=|onclick=/u);
assert.match(normalizeSample('<table><tr><td rowspan="0">All remaining rows</td></tr></table>'), /rowspan="0"/u);

for (const source of [
	'<script>alert(1)</script>',
	'<script src="https://example.com">x</script>',
	'<iframe src="https://example.com"></iframe>',
]) {
	const escaped = normalizeSample(source);
	assert.doesNotMatch(escaped, /<(?:script|iframe)/u);
	assert.match(escaped, /&lt;/u);
}
for (const span of ['', ' colspan="2"']) {
	const unsafe = normalizeSample(
		`<table><tr><td${span}><img src=x onerror=alert(1)><a href="javascript:alert(1)">label</a></td></tr></table>`,
	);
	assert.doesNotMatch(unsafe, /(?<!\\)<img|href="javascript:/u);
	if (span) assert.ok(!nodes(fromHtml(unsafe, { fragment: true })).some((node) => node.type === 'element' && node.tagName === 'img'));
	assert.match(unsafe, /label/u);
}
const nested = normalizeSample('<table><tr><td>outer <table><tr><td>inner</td></tr></table></td></tr></table>');
assert.doesNotMatch(nested, /<table>/u);
assert.match(nested, /outer/u);
assert.match(nested, /inner/u);
for (const span of ['-1', '1001', 'invalid', '1.5']) {
	const invalid = normalizeSample(`<table><tr><td colspan="${span}">Keep cell</td></tr></table>`);
	assert.doesNotMatch(invalid, /<table>/u);
	assert.match(invalid, /Keep cell/u);
}
const mergedEntities = normalizeSample(
	'<table><tr><td colspan="2">A &amp; B &lt;img onerror=x&gt; `a <u>x</u>` $x < y$ [source](https://example.com?a=1&b=2)</td></tr></table>',
);
const mergedNodes = nodes(fromHtml(mergedEntities, { fragment: true }));
assert.ok(mergedNodes.some((node) => node.type === 'text' && node.value.includes('A & B <img onerror=x>')));
assert.ok(mergedNodes.some((node) => node.type === 'element' && node.tagName === 'code' && node.children[0]?.value === 'a <u>x</u>'));
assert.ok(mergedNodes.some((node) => node.type === 'text' && node.value.includes('$x < y$')));
assert.ok(
	mergedNodes.some((node) => node.type === 'element' && node.tagName === 'a' && node.properties.href === 'https://example.com?a=1&b=2'),
);
const unsafeMarkdownLink = normalizeSample('<table><tr><td colspan="2">[click](javascript:alert%281%29)</td></tr></table>');
assert.ok(!nodes(fromHtml(unsafeMarkdownLink)).some((node) => node.type === 'element' && node.tagName === 'a' && node.properties.href));
console.info(`Extracted PDF Markdown checks passed (${samples.length} cases).`);

for (const result of [normalized, noted]) {
	const tree = fromMarkdown(result.markdown);
	const all = nodes(tree);
	const definitions = all.filter((node) => node.type === 'footnoteDefinition').map((node) => node.identifier);
	const references = all.filter((node) => node.type === 'footnoteReference').map((node) => node.identifier);
	assert.equal(definitions.length, new Set(definitions).size);
	assert.ok(
		references.every((id) => definitions.includes(id)),
		'Saved footnotes must have definitions',
	);
}

import { wholeDocumentMarkdown } from '../src/ingest/extracted-pdf-markdown.ts';
import {
	isAllowedPublicPdfUrl,
	LLAMA_PARSE_MAX_PAGES,
	llamaParseAdmissionReason,
	localPdfNeedsFallback,
} from '../src/ingest/platforms/pdf-policy.ts';

const local = (overrides = {}) => ({
	fallbackReasons: ['empty-output'],
	fullPageImagePages: 0,
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
assert.equal(admission({ local: local({ fallbackReasons: ['parse-failed'], totalPages: null }) }), 'page-count-unknown');
assert.equal(admission({ local: local({ fallbackReasons: ['empty-output'], totalPages: LLAMA_PARSE_MAX_PAGES }) }), 'admitted');
assert.equal(
	admission({
		local: local({ fallbackReasons: ['empty-output'], totalPages: LLAMA_PARSE_MAX_PAGES + 1 }),
	}),
	'page-limit-exceeded',
);
assert.equal(admission({ local: local({ fallbackReasons: ['empty-output'], totalPages: 0 }) }), 'page-limit-exceeded');
assert.equal(admission({ source: { kind: 'public-url', url: 'https://localhost/work.pdf' } }), 'source-ineligible');

assert.equal(localPdfNeedsFallback(local({ fallbackReasons: [], fullPageImagePages: 8, totalPages: 10 })), true);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: [], fullPageImagePages: 7, totalPages: 10 })), false);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: [], fullPageImagePages: 0, totalPages: 0 })), false);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: ['empty-output'], totalPages: 10 })), true);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: ['parse-failed'], totalPages: null })), true);
assert.equal(localPdfNeedsFallback(local({ fallbackReasons: ['degraded-page'], totalPages: 10 })), false);
const imageBacked = local({ fallbackReasons: [], fullPageImagePages: 8, totalPages: 10 });
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
