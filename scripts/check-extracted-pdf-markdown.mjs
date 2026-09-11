import assert from 'node:assert/strict';
import { fromHtml } from 'hast-util-from-html';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { normalizeExtractedPdfMarkdown as normalize } from '../src/ingest/extracted-pdf-markdown.ts';

const samples = [];
function normalized(source) {
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

assert.equal(normalized('Uses [<u>[4, 5, 40]</u>] and reigniting<sup>1</sup>.'), 'Uses [4, 5, 40] and reigniting1.');
assert.equal(
	normalized('<th colspan="2">Participation and <Cyan released>, but keep <T>.'),
	'Participation and Cyan released, but keep &lt;T&gt;.',
);
assert.equal(
	normalized('See <Mattern (2020)</Mattern> and <sagepub.com/journals-permissions>.'),
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
for (const source of preserved) assert.equal(normalized(source), source);
assert.equal(normalized('<u>A `keep <u>x</u>`</u>'), 'A `keep <u>x</u>`');
assert.equal(normalized('Note[^one].\n\n[^one]: <u>Details</u>.'), 'Note[^one].\n\n[^one]: Details.');

const simple = normalized(
	'<table><thead><tr><th>Time</th><th>Result</th></tr></thead><tbody><tr><td>Day 1</td><td><b>42</b> <a href="https://example.com">source</a></td></tr></tbody></table>',
);
const simpleTree = parse(simple);
assert.equal(simpleTree.children[0].type, 'table');
assert.ok(nodes(simpleTree).some((node) => node.type === 'strong'));
assert.ok(nodes(simpleTree).some((node) => node.type === 'link' && node.url === 'https://example.com'));
assert.doesNotMatch(simple, /<table>/u);

const mixed = normalized(
	'<table><tr><th>Result</th></tr><tr><td>**bold** [source](https://example.com) $x$ [^one] `a | b <u>c</u>`</td></tr></table>\n\n[^one]: Original note',
);
assert.ok(nodes(parse(mixed)).some((node) => node.type === 'footnoteReference' && node.identifier === 'one'));
assert.ok(nodes(parse(mixed)).some((node) => node.type === 'link' && node.url === 'https://example.com'));
assert.ok(nodes(parse(mixed)).some((node) => node.type === 'inlineCode' && node.value === 'a | b <u>c</u>'));
assert.match(mixed, /\$x\$/u);
assert.match(mixed, /\*\*bold\*\*/u);
const headless = parse(normalized('<table><tr><td>First data row</td><td>42</td></tr></table>')).children[0];
assert.equal(headless.children.length, 2, 'A headless table must retain its first data row below an empty GFM header');

const merged = normalized(
	'<table class="provider"><tr><th colspan="2" style="color:red">Heading</th></tr><tr><td rowspan="2"><b>42</b></td><td><a href="https://example.com" onclick="bad()">source</a><br>Next</td></tr></table>',
);
assert.match(merged, /colspan="2"/u);
assert.match(merged, /rowspan="2"/u);
assert.match(merged, /<strong>42<\/strong>/u);
assert.match(merged, /<a href="https:\/\/example.com">source<\/a><br>Next/u);
assert.doesNotMatch(merged, /class=|style=|onclick=/u);
assert.match(normalized('<table><tr><td rowspan="0">All remaining rows</td></tr></table>'), /rowspan="0"/u);

for (const source of [
	'<script>alert(1)</script>',
	'<script src="https://example.com">x</script>',
	'<iframe src="https://example.com"></iframe>',
]) {
	const escaped = normalized(source);
	assert.doesNotMatch(escaped, /<(?:script|iframe)/u);
	assert.match(escaped, /&lt;/u);
}
for (const span of ['', ' colspan="2"']) {
	const unsafe = normalized(`<table><tr><td${span}><img src=x onerror=alert(1)><a href="javascript:alert(1)">label</a></td></tr></table>`);
	assert.doesNotMatch(unsafe, /(?<!\\)<img|href="javascript:/u);
	if (span) assert.ok(!nodes(fromHtml(unsafe, { fragment: true })).some((node) => node.type === 'element' && node.tagName === 'img'));
	assert.match(unsafe, /label/u);
}
const nested = normalized('<table><tr><td>outer <table><tr><td>inner</td></tr></table></td></tr></table>');
assert.doesNotMatch(nested, /<table>/u);
assert.match(nested, /outer/u);
assert.match(nested, /inner/u);
for (const span of ['-1', '1001', 'invalid', '1.5']) {
	const invalid = normalized(`<table><tr><td colspan="${span}">Keep cell</td></tr></table>`);
	assert.doesNotMatch(invalid, /<table>/u);
	assert.match(invalid, /Keep cell/u);
}
const mergedEntities = normalized(
	'<table><tr><td colspan="2">A &amp; B &lt;img onerror=x&gt; `a <u>x</u>` $x < y$ [source](https://example.com?a=1&b=2)</td></tr></table>',
);
const mergedNodes = nodes(fromHtml(mergedEntities, { fragment: true }));
assert.ok(mergedNodes.some((node) => node.type === 'text' && node.value.includes('A & B <img onerror=x>')));
assert.ok(mergedNodes.some((node) => node.type === 'element' && node.tagName === 'code' && node.children[0]?.value === 'a <u>x</u>'));
assert.ok(mergedNodes.some((node) => node.type === 'text' && node.value.includes('$x < y$')));
assert.ok(
	mergedNodes.some((node) => node.type === 'element' && node.tagName === 'a' && node.properties.href === 'https://example.com?a=1&b=2'),
);
const unsafeMarkdownLink = normalized('<table><tr><td colspan="2">[click](javascript:alert%281%29)</td></tr></table>');
assert.ok(!nodes(fromHtml(unsafeMarkdownLink)).some((node) => node.type === 'element' && node.tagName === 'a' && node.properties.href));
console.info(`Extracted PDF Markdown checks passed (${samples.length} cases).`);
