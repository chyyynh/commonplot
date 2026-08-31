import assert from 'node:assert/strict';

const {
	MarkdownTranslationInvariantError,
	compileMarkdownTranslation,
	createMarkdownTranslationTemplate,
	planMarkdownTranslation,
	validateMarkdownBatchTranslations,
} = await import('../src/ingest/markdown-translation.ts');

function targetFromSource(segment, translateText = (value) => value) {
	const template = createMarkdownTranslationTemplate(segment);
	return {
		id: segment.id,
		sequences: Object.fromEntries(
			Object.entries(template.sequences).map(([sequenceId, parts]) => [
				sequenceId,
				parts.map((part) => (typeof part === 'string' ? { type: 'text', value: translateText(part) } : { type: 'inline', value: part.id })),
			]),
		),
	};
}

function withRootParts(translation, parts) {
	return { ...translation, sequences: { ...translation.sequences, root: parts } };
}

function inlineIdsOfKind(template, kind) {
	return Object.entries(template.inlines).flatMap(([id, inline]) => (inline.kind === kind ? [id] : []));
}

const markdownFixture = `---
title: Opaque frontmatter metadata
translation: disabled
---

# Format-safe translation

Read the **full [research report](https://example.com/report?q=1 "Original title")** before running \`pnpm test\`.

Lift coefficient $C_L$ and the display equation below remain opaque.

$$
E = mc^2
$$

> A quoted paragraph with *emphasis*, ~~old wording~~, and an autolink https://example.com/opaque.

- [x] Preserve completed tasks
- [ ] Translate unfinished tasks

1. Keep ordered list numbering
   - Preserve nested unordered lists
2. Translate every prose item

| Field | Meaning |
| :--- | ---: |
| URL | Keep destinations unchanged |
| Code | Keep syntax unchanged |

![A descriptive chart](https://cdn.example.com/chart.png "Chart title")

<aside data-kind="note">Opaque HTML must stay untouched.</aside>

~~~ts
const markdown = "**not translated**";
console.log(markdown);
~~~

    SELECT * FROM protected_code;

Contact user@example.com and see the source.[^source]

The quoted price is ($57) under [the terms](https://example.com/price), but later became ($60).

[^source]: Footnote prose with a [reference][docs].

[docs]: https://example.com/docs "Documentation title"
`;

const options = {
	maxBatchCharacters: 900,
	maxBatchSegments: 4,
	maxContextCharacters: 100,
	maxSegmentCharacters: 700,
};
const plan = planMarkdownTranslation(markdownFixture, options);
assert.ok(plan.segments.length > 10, 'fixture should produce independently addressable prose blocks');
assert.ok(plan.batches.length > 1, 'fixture should exercise deterministic batching');
assert.deepEqual(planMarkdownTranslation(markdownFixture, options), plan, 'translation planning must be deterministic');
for (const hiddenDestination of ['https://example.com/report?q=1', 'https://example.com/opaque', 'https://cdn.example.com/chart.png']) {
	assert.ok(
		plan.segments.every(
			(segment) =>
				!JSON.stringify(createMarkdownTranslationTemplate(segment)).includes(hiddenDestination) &&
				!segment.context?.includes(hiddenDestination),
		),
		`protected destination leaked into model input: ${hiddenDestination}`,
	);
}
for (const batch of plan.batches) {
	assert.ok(batch.inputCharacters <= options.maxBatchCharacters, `${batch.id} exceeded its input character budget`);
}

const translations = plan.segments.map((segment) =>
	targetFromSource(segment, (value) =>
		value
			.replace('Format-safe translation', '格式安全翻譯')
			.replace('research report', '研究報告')
			.replace('A descriptive chart', '描述性圖表')
			.replace('Footnote prose', '註腳文字'),
	),
);
const translatedMarkdown = compileMarkdownTranslation(plan, translations);

for (const protectedValue of [
	'https://example.com/report?q=1',
	'title: Opaque frontmatter metadata',
	'translation: disabled',
	'Original title',
	'C_L',
	'E = mc^2',
	'https://example.com/opaque',
	'https://cdn.example.com/chart.png',
	'Chart title',
	'https://example.com/docs',
	'Documentation title',
	'pnpm test',
	'const markdown = "**not translated**";',
	'SELECT * FROM protected_code;',
	'<aside data-kind="note">Opaque HTML must stay untouched.</aside>',
	'user@example.com',
	'$57',
	'$60',
]) {
	assert.ok(translatedMarkdown.includes(protectedValue), `protected Markdown value changed: ${protectedValue}`);
}
assert.match(translatedMarkdown, /^[*+-] \[x\]/m, 'checked task state changed');
assert.match(translatedMarkdown, /^[*+-] \[ \]/m, 'unchecked task state changed');

const firstBatch = plan.batches[0];
assert.ok(firstBatch, 'fixture must contain a batch');
assert.deepEqual(
	validateMarkdownBatchTranslations(firstBatch, translations.slice(0, firstBatch.segments.length)),
	translations.slice(0, firstBatch.segments.length),
);

assert.throws(
	() => compileMarkdownTranslation(plan, translations.slice(1)),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'missing-segment',
	'missing segment results must fail closed',
);
assert.throws(
	() =>
		validateMarkdownBatchTranslations(firstBatch, [
			{ ...translations[0], id: 'unknown' },
			...translations.slice(1, firstBatch.segments.length),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'unknown-segment',
	'unknown segment IDs must fail closed',
);
const firstTranslation = translations[0];
const firstRootPart = firstTranslation?.sequences.root?.[0];
assert.ok(firstTranslation && firstRootPart?.type === 'text', 'first fixture translation must start with root prose');
assert.throws(
	() =>
		validateMarkdownBatchTranslations(firstBatch, [
			withRootParts(firstTranslation, [{ ...firstRootPart, value: ` ${firstRootPart.value}` }]),
			...translations.slice(1, firstBatch.segments.length),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'leading or trailing model whitespace must fail closed',
);
assert.throws(
	() =>
		validateMarkdownBatchTranslations(firstBatch, [
			withRootParts(firstTranslation, [{ type: 'text', value: '第一段\n\n意外的新段落' }]),
			...translations.slice(1, firstBatch.segments.length),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'blank lines inside a prose segment must retry before reconstruction',
);

const linkBatch = plan.batches.find((batch) => batch.segments.some((segment) => segment.text.includes('research report')));
assert.ok(linkBatch, 'fixture must contain a translated link block');
const linkSegment = linkBatch.segments.find((segment) => segment.text.includes('research report'));
assert.ok(linkSegment, 'fixture must expose the translated link label inside a complete prose block');
assert.match(linkSegment.text, /^Read the /u, 'inline formatting must not split a sentence into separate translation slots');
const linkTemplate = createMarkdownTranslationTemplate(linkSegment);
assert.doesNotMatch(JSON.stringify(linkTemplate), /<\/?n-[0-9]{6}>|<n-[0-9]{6}\/>/u, 'model input must not expose internal tokens');
assert.ok(translatedMarkdown.includes('[研究報告](https://example.com/report?q=1'), 'translated link label must keep its destination');

const reorderedPlan = planMarkdownTranslation('The market [expects](https://example.com/forecast) electric vehicles.');
const reorderedSegment = reorderedPlan.segments[0];
assert.ok(reorderedSegment, 'reordered-inline fixture must produce one complete prose block');
const reorderedTemplate = createMarkdownTranslationTemplate(reorderedSegment);
const reorderedInlineId = inlineIdsOfKind(reorderedTemplate, 'link')[0];
assert.ok(reorderedInlineId, 'reordered-inline fixture must describe its link');
assert.deepEqual(
	reorderedTemplate,
	{
		inlines: { 'n-000001': { kind: 'link' } },
		sequences: {
			root: ['The market ', { id: 'n-000001' }, ' electric vehicles.'],
			'n-000001': ['expects'],
		},
	},
	'model input must expose a movable inline reference and a separately scoped link-label sequence',
);
const reorderedMarkdown = compileMarkdownTranslation(reorderedPlan, [
	{
		id: reorderedSegment.id,
		sequences: {
			root: [
				{ type: 'inline', value: reorderedInlineId },
				{ type: 'text', value: '市場將以電動車為主。' },
			],
			[reorderedInlineId]: [{ type: 'text', value: '預期' }],
		},
	},
]);
assert.ok(
	reorderedMarkdown.includes(`[預期](https://example.com/forecast)市場將以電動車為主。`),
	'complete prose translation must allow inline markup to move with natural target-language word order',
);

const naturalParagraphPlan = planMarkdownTranslation(
	'These devices demand [less attention](https://example.com/less), including Garmin [Cirqa](https://example.com/cirqa), [Fitbit Air](https://example.com/fitbit), and the *Whoop series*.',
);
assert.equal(naturalParagraphPlan.segments.length, 1, 'one paragraph with multiple inline nodes must remain one semantic translation unit');
const naturalParagraphSegment = naturalParagraphPlan.segments[0];
assert.ok(naturalParagraphSegment, 'natural-language fixture must produce a segment');
const naturalTemplate = createMarkdownTranslationTemplate(naturalParagraphSegment);
const [lessAttentionId, cirqaId, fitbitId] = inlineIdsOfKind(naturalTemplate, 'link');
const whoopId = inlineIdsOfKind(naturalTemplate, 'emphasis')[0];
assert.ok(lessAttentionId && cirqaId && fitbitId && whoopId, 'natural-language fixture must expose its four inline containers');
const naturalTranslation = {
	id: naturalParagraphSegment.id,
	sequences: {
		root: [
			{ type: 'text', value: '這類裝置會' },
			{ type: 'inline', value: lessAttentionId },
			{ type: 'text', value: '，目前包括 Garmin ' },
			{ type: 'inline', value: cirqaId },
			{ type: 'text', value: '、' },
			{ type: 'inline', value: fitbitId },
			{ type: 'text', value: '，以及' },
			{ type: 'inline', value: whoopId },
			{ type: 'text', value: '。' },
		],
		[lessAttentionId]: [{ type: 'text', value: '減少對注意力的要求' }],
		[cirqaId]: [{ type: 'text', value: 'Cirqa' }],
		[fitbitId]: [{ type: 'text', value: 'Fitbit Air' }],
		[whoopId]: [{ type: 'text', value: 'Whoop 系列' }],
	},
};
const naturalParagraphMarkdown = compileMarkdownTranslation(naturalParagraphPlan, [naturalTranslation]);
assert.ok(
	naturalParagraphMarkdown.includes(
		'這類裝置會[減少對注意力的要求](https://example.com/less)，目前包括 Garmin [Cirqa](https://example.com/cirqa)、[Fitbit Air](https://example.com/fitbit)，以及*Whoop 系列*。',
	),
	'whole-paragraph reconstruction must preserve natural Chinese punctuation and link boundaries without injected spaces',
);
assert.throws(
	() =>
		compileMarkdownTranslation(naturalParagraphPlan, [
			{
				...naturalTranslation,
				sequences: { ...naturalTranslation.sequences, [lessAttentionId]: [] },
			},
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'model output must not erase prose inside a container sequence',
);

const inlineCodePlan = planMarkdownTranslation(
	'Add options to the existing `GRUB_CMDLINE_LINUX_DEFAULT` value in `/etc/default/grub`, then apply them with:',
);
const inlineCodeSegment = inlineCodePlan.segments[0];
assert.ok(inlineCodeSegment, 'inline-code fixture must produce a segment');
const inlineCodeTemplate = createMarkdownTranslationTemplate(inlineCodeSegment);
assert.deepEqual(
	inlineCodeTemplate,
	{
		inlines: {
			'n-000001': { kind: 'inlineCode', reference: 'GRUB_CMDLINE_LINUX_DEFAULT' },
			'n-000002': { kind: 'inlineCode', reference: '/etc/default/grub' },
		},
		sequences: {
			root: ['Add options to the existing ', { id: 'n-000001' }, ' value in ', { id: 'n-000002' }, ', then apply them with:'],
		},
	},
	'opaque inline code must reach the model as movable references with read-only semantic previews',
);
const [settingInlineId, pathInlineId] = inlineIdsOfKind(inlineCodeTemplate, 'inlineCode');
assert.ok(settingInlineId && pathInlineId, 'inline-code fixture must expose both atoms');
const inlineCodeTranslation = {
	id: inlineCodeSegment.id,
	sequences: {
		root: [
			{ type: 'text', value: '請在' },
			{ type: 'inline', value: pathInlineId },
			{ type: 'text', value: '中，將選項加入現有的' },
			{ type: 'inline', value: settingInlineId },
			{ type: 'text', value: '值，然後執行以下指令：' },
		],
	},
};
assert.equal(
	compileMarkdownTranslation(inlineCodePlan, [inlineCodeTranslation]),
	'請在`/etc/default/grub`中，將選項加入現有的`GRUB_CMDLINE_LINUX_DEFAULT`值，然後執行以下指令：',
	'Core must let multiple atomic inline nodes move to natural target-language positions',
);

for (const [parts, message] of [
	[
		[
			{ type: 'inline', value: settingInlineId },
			{ type: 'inline', value: settingInlineId },
			{ type: 'inline', value: pathInlineId },
		],
		'duplicate inline references must fail closed',
	],
	[[{ type: 'inline', value: settingInlineId }], 'missing inline references must fail closed'],
	[
		[
			{ type: 'inline', value: settingInlineId },
			{ type: 'inline', value: pathInlineId },
			{ type: 'inline', value: 'n-999999' },
		],
		'unknown inline references must fail closed',
	],
]) {
	assert.throws(
		() => compileMarkdownTranslation(inlineCodePlan, [withRootParts(inlineCodeTranslation, parts)]),
		(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'markdown-structure-changed',
		message,
	);
}

const nestedPlan = planMarkdownTranslation('Read the **full [research report](https://example.com/report)** before running `pnpm test`.');
const nestedSegment = nestedPlan.segments[0];
assert.ok(nestedSegment, 'nested-inline fixture must produce a segment');
const nestedTemplate = createMarkdownTranslationTemplate(nestedSegment);
const strongInlineId = inlineIdsOfKind(nestedTemplate, 'strong')[0];
const nestedLinkInlineId = inlineIdsOfKind(nestedTemplate, 'link')[0];
const codeInlineId = inlineIdsOfKind(nestedTemplate, 'inlineCode')[0];
assert.ok(strongInlineId && nestedLinkInlineId && codeInlineId, 'nested-inline fixture must expose strong, link, and code nodes');
const nestedTranslation = {
	id: nestedSegment.id,
	sequences: {
		root: [
			{ type: 'text', value: '執行' },
			{ type: 'inline', value: codeInlineId },
			{ type: 'text', value: '前，請先閱讀' },
			{ type: 'inline', value: strongInlineId },
			{ type: 'text', value: '。' },
		],
		[strongInlineId]: [
			{ type: 'text', value: '完整的' },
			{ type: 'inline', value: nestedLinkInlineId },
		],
		[nestedLinkInlineId]: [{ type: 'text', value: '研究報告' }],
	},
};
assert.equal(
	compileMarkdownTranslation(nestedPlan, [nestedTranslation]),
	'執行`pnpm test`前，請先閱讀**完整的[研究報告](https://example.com/report)**。',
	'nested inline containers must move as complete nodes while preserving their child scopes',
);
assert.throws(
	() =>
		compileMarkdownTranslation(nestedPlan, [
			withRootParts(nestedTranslation, [
				{ type: 'inline', value: codeInlineId },
				{ type: 'inline', value: strongInlineId },
			]),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'direct prose in a non-leaf sequence must not disappear behind translated child content',
);
assert.throws(
	() =>
		compileMarkdownTranslation(nestedPlan, [
			withRootParts(nestedTranslation, [
				{ type: 'inline', value: codeInlineId },
				{ type: 'inline', value: nestedLinkInlineId },
			]),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'markdown-structure-changed',
	'nested inline references must not escape their parent sequence',
);
const missingNestedSequence = { ...nestedTranslation.sequences };
delete missingNestedSequence[nestedLinkInlineId];
assert.throws(
	() => compileMarkdownTranslation(nestedPlan, [{ ...nestedTranslation, sequences: missingNestedSequence }]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'markdown-structure-changed',
	'missing container sequences must fail closed',
);
assert.throws(
	() => compileMarkdownTranslation(nestedPlan, [{ ...nestedTranslation, sequences: { ...nestedTranslation.sequences, invented: [] } }]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'markdown-structure-changed',
	'extra container sequences must fail closed',
);

const inlineHtmlPlan = planMarkdownTranslation('Before <mark>highlighted</mark> after.');
const inlineHtmlSegment = inlineHtmlPlan.segments[0];
assert.ok(inlineHtmlSegment, 'inline-HTML fixture must produce a segment');
const inlineHtmlTemplate = createMarkdownTranslationTemplate(inlineHtmlSegment);
const [openMarkId, closeMarkId] = inlineIdsOfKind(inlineHtmlTemplate, 'html');
assert.ok(openMarkId && closeMarkId, 'inline-HTML fixture must expose both raw tag atoms');
assert.deepEqual(
	inlineHtmlTemplate.inlines,
	{
		[openMarkId]: { canReorder: false, kind: 'html' },
		[closeMarkId]: { canReorder: false, kind: 'html' },
	},
	'raw inline HTML must be fixed structural anchors',
);
const inlineHtmlTranslation = {
	id: inlineHtmlSegment.id,
	sequences: {
		root: [
			{ type: 'text', value: '之前' },
			{ type: 'inline', value: openMarkId },
			{ type: 'text', value: '醒目文字' },
			{ type: 'inline', value: closeMarkId },
			{ type: 'text', value: '之後。' },
		],
	},
};
assert.equal(
	compileMarkdownTranslation(inlineHtmlPlan, [inlineHtmlTranslation]),
	'之前<mark>醒目文字</mark>之後。',
	'fixed raw HTML anchors must retain translated prose inside their original slot',
);
assert.throws(
	() =>
		compileMarkdownTranslation(inlineHtmlPlan, [
			withRootParts(inlineHtmlTranslation, [
				{ type: 'inline', value: openMarkId },
				{ type: 'inline', value: closeMarkId },
				{ type: 'text', value: '全部譯文' },
			]),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'prose must not move out of a raw HTML tag pair',
);
assert.throws(
	() =>
		compileMarkdownTranslation(inlineHtmlPlan, [
			withRootParts(inlineHtmlTranslation, [
				{ type: 'text', value: '之前' },
				{ type: 'inline', value: openMarkId },
				{ type: 'text', value: '。' },
				{ type: 'inline', value: closeMarkId },
				{ type: 'text', value: '醒目文字之後。' },
			]),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'punctuation alone must not stand in for substantive prose inside a fixed slot',
);

const citationPlan = planMarkdownTranslation('First claim.[^a] Second claim.[^b]\n\n[^a]: First note.\n[^b]: Second note.');
const citationSegment = citationPlan.segments.find(
	(segment) => inlineIdsOfKind(createMarkdownTranslationTemplate(segment), 'footnoteReference').length === 2,
);
assert.ok(citationSegment, 'citation fixture must expose two footnote references in one segment');
const citationTemplate = createMarkdownTranslationTemplate(citationSegment);
const [firstCitationId, secondCitationId] = inlineIdsOfKind(citationTemplate, 'footnoteReference');
assert.ok(firstCitationId && secondCitationId, 'citation fixture must expose stable reference IDs');
const citationTranslations = citationPlan.segments.map((segment) => targetFromSource(segment));
const citationIndex = citationPlan.segments.findIndex((segment) => segment.id === citationSegment.id);
citationTranslations[citationIndex] = withRootParts(citationTranslations[citationIndex], [
	{ type: 'text', value: 'First claim.' },
	{ type: 'inline', value: secondCitationId },
	{ type: 'text', value: ' Second claim.' },
	{ type: 'inline', value: firstCitationId },
]);
assert.throws(
	() => compileMarkdownTranslation(citationPlan, citationTranslations),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'markdown-structure-changed',
	'opaque citation references must remain anchored to their original claims',
);

const denseInlineMarkdown = Array.from({ length: 100 }, (_, index) => `Read [link ${index}](https://example.com/${index}).`).join(' ');
const denseInlinePlan = planMarkdownTranslation(denseInlineMarkdown);
assert.equal(denseInlinePlan.segments.length, 1, 'dense inline prose should remain one semantic segment');
assert.ok(
	denseInlinePlan.batches.every((batch) => batch.inputCharacters <= 8_000),
	'compact source IR must keep a 100-link paragraph inside the production batch budget',
);

const malformedMarkdown = `## Malformed but parseable\n\nAn **unclosed delimiter and a [broken link label must remain ordinary prose.`;
const malformedPlan = planMarkdownTranslation(malformedMarkdown);
const malformedTranslation = compileMarkdownTranslation(
	malformedPlan,
	malformedPlan.segments.map((segment) => targetFromSource(segment, () => '仍然是安全的普通文字')),
);
assert.ok(malformedTranslation, 'malformed-but-parseable Markdown must round-trip safely');

const longMarkdown = `# Long body\n\n${'A long paragraph with enough prose to translate safely. '.repeat(1_200)}`;
assert.ok(longMarkdown.length > 36_000, 'long-body fixture must exceed the retired body ceiling');
const longPlan = planMarkdownTranslation(longMarkdown, {
	maxBatchCharacters: 2_000,
	maxBatchSegments: 8,
	maxContextCharacters: 100,
	maxSegmentCharacters: 1_500,
});
assert.ok(longPlan.batches.length > 1, 'long bodies must translate through multiple batches');
assert.equal(
	compileMarkdownTranslation(
		longPlan,
		longPlan.segments.map((segment) => targetFromSource(segment)),
	),
	longMarkdown.trimEnd(),
	'long prose segmentation and reconstruction must not drop content',
);

console.info({
	batchCount: plan.batches.length,
	event: 'markdown_translation_contract_passed',
	longBodyBatchCount: longPlan.batches.length,
	segmentCount: plan.segments.length,
});
