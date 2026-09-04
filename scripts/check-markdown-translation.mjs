import assert from 'node:assert/strict';

const {
	MarkdownTranslationInvariantError,
	compileMarkdownTranslation,
	compileMarkdownTranslationArtifact,
	createMarkdownTranslationTemplate,
	planMarkdownTranslation,
	validateMarkdownBatchTranslations,
} = await import('../src/ingest/markdown-translation.ts');

function materializeTranslation(translation, partOrder = translation.partOrder, texts = translation.texts) {
	return {
		...translation,
		partOrder,
		sequences: partOrder,
		texts,
	};
}

function targetFromSource(segment, translateText = (value) => value) {
	const template = createMarkdownTranslationTemplate(segment);
	return materializeTranslation({
		id: segment.id,
		partOrder: template.sequences,
		texts: Object.fromEntries(Object.entries(template.texts).map(([textId, value]) => [textId, translateText(value)])),
	});
}

function textIdsInSequence(template, sequenceId = 'root') {
	return (template.sequences[sequenceId] ?? []).filter((partId) => Object.hasOwn(template.texts, partId));
}

function withSequenceOrder(translation, sequenceId, order) {
	return materializeTranslation(translation, { ...translation.partOrder, [sequenceId]: order });
}

function withTranslatedTexts(translation, values) {
	return materializeTranslation(translation, translation.partOrder, { ...translation.texts, ...values });
}

function inlineIdsOfKind(template, kind) {
	return Object.entries(template.inlines).flatMap(([id, inline]) =>
		(typeof inline === 'string' ? inline : inline.kind) === kind ? [id] : [],
	);
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
for (const hiddenDestination of ['https://example.com/report?q=1', 'https://cdn.example.com/chart.png']) {
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
const translatedArtifact = compileMarkdownTranslationArtifact(plan, translations);
assert.equal(translatedArtifact.content, translatedMarkdown, 'aligned artifact content must remain the canonical plain Markdown');
assert.equal(translatedArtifact.alignment.version, 1);
assert.equal(
	translatedArtifact.alignment.blocks.length,
	plan.targets.length,
	'every planned prose block must have one persisted alignment',
);
assert.ok(
	translatedArtifact.alignment.blocks.some(
		(block) => block.sourceMarkdown.includes('Format-safe translation') && block.translatedMarkdown.includes('格式安全翻譯'),
	),
	'alignment must carry the exact source and translated block produced by the structural plan',
);

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

const adjacentAttentionPlan = planMarkdownTranslation(
	'*Enhancement* *Quantification:* Measuring the precise amount of methane present in every pixel per plume.',
);
const adjacentAttentionSegment = adjacentAttentionPlan.segments[0];
assert.ok(adjacentAttentionSegment, 'adjacent-attention fixture must produce one prose segment');
const adjacentAttentionTemplate = createMarkdownTranslationTemplate(adjacentAttentionSegment);
const adjacentEmphasisIds = inlineIdsOfKind(adjacentAttentionTemplate, 'emphasis');
assert.equal(adjacentEmphasisIds.length, 2, 'adjacent-attention fixture must expose both emphasis nodes');
const [adjacentGapTextId, adjacentBodyTextId] = textIdsInSequence(adjacentAttentionTemplate);
assert.ok(adjacentGapTextId && adjacentBodyTextId, 'adjacent-attention fixture must expose its gap and body text IDs');
const adjacentAttentionSourceTranslation = targetFromSource(adjacentAttentionSegment, (value) =>
	value
		.replace('Enhancement', '增強量')
		.replace('Quantification:', '量化：')
		.replace('Measuring the precise amount of methane present in every pixel per plume.', '測量每條羽流中每個像素所含甲烷的精確數量。'),
);
const adjacentAttentionMarkdown = compileMarkdownTranslation(adjacentAttentionPlan, [
	withTranslatedTexts(
		withSequenceOrder(adjacentAttentionSourceTranslation, 'root', [
			adjacentEmphasisIds[0],
			adjacentEmphasisIds[1],
			adjacentGapTextId,
			adjacentBodyTextId,
		]),
		{ [adjacentGapTextId]: '' },
	),
]);
assert.match(
	adjacentAttentionMarkdown,
	/^\*增強量\* \*量化：\*/u,
	'adjacent emphasis must retain two nodes when target-language spacing is removed',
);

const duplicatedSequencePlan = planMarkdownTranslation(
	'*Plume Delineation:* Precisely segmenting the shape and boundaries of a plume, even when multiple plumes overlap.',
);
const duplicatedSequenceSegment = duplicatedSequencePlan.segments[0];
assert.ok(duplicatedSequenceSegment, 'cross-sequence duplication fixture must produce one prose segment');
const duplicatedSequenceTemplate = createMarkdownTranslationTemplate(duplicatedSequenceSegment);
const duplicatedSequenceEmphasisId = inlineIdsOfKind(duplicatedSequenceTemplate, 'emphasis')[0];
assert.ok(duplicatedSequenceEmphasisId, 'cross-sequence duplication fixture must expose its emphasis node');
const duplicatedRootTextId = textIdsInSequence(duplicatedSequenceTemplate)[0];
const duplicatedInlineTextId = textIdsInSequence(duplicatedSequenceTemplate, duplicatedSequenceEmphasisId)[0];
assert.ok(duplicatedRootTextId && duplicatedInlineTextId, 'cross-sequence duplication fixture must expose both text IDs');
const repeatedTranslation = '回溯追蹤擴散的氣體，精確定位排放源。';
const duplicatedSequenceTranslation = targetFromSource(duplicatedSequenceSegment);
assert.throws(
	() =>
		compileMarkdownTranslation(duplicatedSequencePlan, [
			withTranslatedTexts(duplicatedSequenceTranslation, {
				[duplicatedRootTextId]: repeatedTranslation,
				[duplicatedInlineTextId]: `羽流描繪：${repeatedTranslation}`,
			}),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'new cross-sequence duplication must remain visible as an error instead of being silently rewritten',
);

const longInlineMathFixture = String.raw`A real formula can be longer than ordinary prose.

$$ \underbrace{\log p(z\_s \mid z\_t, y)}\_{\text{conditional distribution}} = \underbrace{\log p(y \mid z\_t, z\_s)}\_{\text{predictive term}} + \underbrace{\log p(z\_s \mid z\_t)}\_{\text{unconditional term}} + c, $$

The equation remains part of the article.`;
const longInlineMathPlan = planMarkdownTranslation(longInlineMathFixture);
const longInlineMathResult = compileMarkdownTranslation(
	longInlineMathPlan,
	longInlineMathPlan.segments.map((segment) => targetFromSource(segment)),
);
assert.match(longInlineMathResult, /\\underbrace\{\\log p/u, 'valid long inline math must survive package round-tripping');

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
const firstRootTextId = firstTranslation ? textIdsInSequence(createMarkdownTranslationTemplate(plan.segments[0]))[0] : undefined;
assert.ok(firstTranslation && firstRootTextId, 'first fixture translation must start with root prose');
assert.throws(
	() =>
		validateMarkdownBatchTranslations(firstBatch, [
			withTranslatedTexts(firstTranslation, { [firstRootTextId]: ` ${firstTranslation.texts[firstRootTextId]}` }),
			...translations.slice(1, firstBatch.segments.length),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'leading or trailing model whitespace must fail closed',
);
assert.throws(
	() =>
		validateMarkdownBatchTranslations(firstBatch, [
			withTranslatedTexts(firstTranslation, { [firstRootTextId]: '第一段\n\n意外的新段落' }),
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
assert.doesNotMatch(JSON.stringify(linkTemplate), /<\/?n[0-9]+>|<n[0-9]+\/>/u, 'model input must not expose internal tokens');
assert.ok(translatedMarkdown.includes('[研究報告](https://example.com/report?q=1'), 'translated link label must keep its destination');

const autolinkPlan = planMarkdownTranslation('Contact <verify@amazon.com> for help.');
const autolinkSegment = autolinkPlan.segments[0];
assert.ok(autolinkSegment, 'autolink fixture must produce one prose segment');
const autolinkTemplate = createMarkdownTranslationTemplate(autolinkSegment);
const autolinkId = inlineIdsOfKind(autolinkTemplate, 'link')[0];
const autolinkTextIds = textIdsInSequence(autolinkTemplate);
assert.ok(autolinkId && autolinkTextIds.length === 2, 'autolink fixture must expose one movable reference inside one root sequence');
assert.deepEqual(
	autolinkTemplate.inlines[autolinkId],
	{ kind: 'link', reference: 'verify@amazon.com' },
	'autolink input must expose its visible address without exposing or editing the destination',
);
assert.deepEqual(Object.keys(autolinkTemplate.sequences), ['root'], 'a movable autolink must not split one sentence into fixed slots');
const autolinkMarkdown = compileMarkdownTranslation(autolinkPlan, [
	withTranslatedTexts(targetFromSource(autolinkSegment), {
		[autolinkTextIds[0]]: '請聯絡',
		[autolinkTextIds[1]]: '取得協助。',
	}),
]);
assert.equal(autolinkMarkdown, '請聯絡<verify@amazon.com>取得協助。', 'Core must restore the exact email autolink after translation');

const emptyLinkPlan = planMarkdownTranslation('[](https://example.com/heading)A complementary portfolio of models');
const emptyLinkSegment = emptyLinkPlan.segments[0];
assert.ok(emptyLinkSegment, 'empty-link fixture must produce one prose segment');
const emptyLinkTemplate = createMarkdownTranslationTemplate(emptyLinkSegment);
assert.deepEqual(
	emptyLinkTemplate.inlines,
	{},
	'an invisible empty link must remain Core-owned instead of becoming a translatable container',
);
assert.deepEqual(Object.keys(emptyLinkTemplate.sequences), ['root'], 'an empty link at the edge must not create a redundant slot sequence');
const emptyLinkTextId = textIdsInSequence(emptyLinkTemplate)[0];
assert.ok(emptyLinkTextId, 'empty-link fixture must expose its visible heading text');
assert.equal(
	compileMarkdownTranslation(emptyLinkPlan, [
		withTranslatedTexts(targetFromSource(emptyLinkSegment), { [emptyLinkTextId]: '與決策相符的互補模型組合' }),
	]),
	'[](https://example.com/heading)與決策相符的互補模型組合',
	'Core must translate the visible heading without asking the model to fill an empty link',
);

const scopedTextPlan = planMarkdownTranslation('**Zero configuration:** Confluent manages model serving and runtime operations.');
const scopedTextSegment = scopedTextPlan.segments[0];
assert.ok(scopedTextSegment, 'scoped-text fixture must produce one prose segment');
const scopedTextTemplate = createMarkdownTranslationTemplate(scopedTextSegment);
const scopedStrongId = inlineIdsOfKind(scopedTextTemplate, 'strong')[0];
const scopedRootTextId = textIdsInSequence(scopedTextTemplate)[0];
const scopedStrongTextId = scopedStrongId ? textIdsInSequence(scopedTextTemplate, scopedStrongId)[0] : undefined;
assert.ok(scopedStrongId && scopedRootTextId && scopedStrongTextId, 'scoped-text fixture must expose separate root and strong text IDs');
const scopedTranslation = targetFromSource(scopedTextSegment);
assert.throws(
	() =>
		compileMarkdownTranslation(scopedTextPlan, [
			withTranslatedTexts(scopedTranslation, {
				[scopedRootTextId]: '',
				[scopedStrongTextId]: '零設定：Confluent 負責模型服務與執行階段維運。',
			}),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'body prose moved into a bold label must fail instead of silently formatting the whole paragraph',
);

const reorderedPlan = planMarkdownTranslation('The market [expects](https://example.com/forecast) electric vehicles.');
const reorderedSegment = reorderedPlan.segments[0];
assert.ok(reorderedSegment, 'reordered-inline fixture must produce one complete prose block');
const reorderedTemplate = createMarkdownTranslationTemplate(reorderedSegment);
const reorderedInlineId = inlineIdsOfKind(reorderedTemplate, 'link')[0];
assert.ok(reorderedInlineId, 'reordered-inline fixture must describe its link');
assert.deepEqual(
	reorderedTemplate,
	{
		inlines: { n1: 'link' },
		texts: {
			t1: 'The market ',
			t2: ' electric vehicles.',
			t3: 'expects',
		},
		sequences: {
			root: ['t1', 'n1', 't2'],
			n1: ['t3'],
		},
	},
	'model input must expose a movable inline reference and a separately scoped link-label sequence',
);
const reorderedTranslation = withTranslatedTexts(
	withSequenceOrder(targetFromSource(reorderedSegment), 'root', [reorderedInlineId, 't1', 't2']),
	{
		t1: '市場',
		t2: '將以電動車為主。',
		t3: '預期',
	},
);
const reorderedMarkdown = compileMarkdownTranslation(reorderedPlan, [reorderedTranslation]);
assert.ok(
	reorderedMarkdown.includes(`[預期](https://example.com/forecast)市場將以電動車為主。`),
	'complete prose translation must allow inline markup to move with natural target-language word order',
);

const disappearingArticlePlan = planMarkdownTranslation(
	'The [filing](https://example.com/filing) shows that revenue increased substantially.',
);
const disappearingArticleSegment = disappearingArticlePlan.segments[0];
assert.ok(disappearingArticleSegment, 'article regression fixture must produce one prose segment');
const disappearingArticleTemplate = createMarkdownTranslationTemplate(disappearingArticleSegment);
const filingInlineId = inlineIdsOfKind(disappearingArticleTemplate, 'link')[0];
assert.ok(filingInlineId, 'article regression fixture must expose its link');
assert.equal(
	compileMarkdownTranslation(disappearingArticlePlan, [
		withTranslatedTexts(targetFromSource(disappearingArticleSegment), {
			t1: '',
			t2: '顯示，營收大幅成長。',
			t3: '申報文件',
		}),
	]),
	'[申報文件](https://example.com/filing)顯示，營收大幅成長。',
	'natural Chinese may omit an English article without erasing the enclosing sequence',
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
const naturalRootTextIds = textIdsInSequence(naturalTemplate);
const lessAttentionTextId = textIdsInSequence(naturalTemplate, lessAttentionId)[0];
const cirqaTextId = textIdsInSequence(naturalTemplate, cirqaId)[0];
const fitbitTextId = textIdsInSequence(naturalTemplate, fitbitId)[0];
const whoopTextId = textIdsInSequence(naturalTemplate, whoopId)[0];
assert.equal(naturalRootTextIds.length, 5, 'natural-language fixture must expose five root text positions');
assert.ok(lessAttentionTextId && cirqaTextId && fitbitTextId && whoopTextId, 'natural-language fixture must expose inline text IDs');
const naturalTranslation = withTranslatedTexts(targetFromSource(naturalParagraphSegment), {
	[naturalRootTextIds[0]]: '這類裝置會',
	[naturalRootTextIds[1]]: '，目前包括 Garmin ',
	[naturalRootTextIds[2]]: '、',
	[naturalRootTextIds[3]]: '，以及',
	[naturalRootTextIds[4]]: '。',
	[lessAttentionTextId]: '減少對注意力的要求',
	[cirqaTextId]: 'Cirqa',
	[fitbitTextId]: 'Fitbit Air',
	[whoopTextId]: 'Whoop 系列',
});
const naturalParagraphMarkdown = compileMarkdownTranslation(naturalParagraphPlan, [naturalTranslation]);
assert.ok(
	naturalParagraphMarkdown.includes(
		'這類裝置會[減少對注意力的要求](https://example.com/less)，目前包括 Garmin [Cirqa](https://example.com/cirqa)、[Fitbit Air](https://example.com/fitbit)，以及*Whoop 系列*。',
	),
	'whole-paragraph reconstruction must preserve natural Chinese punctuation and link boundaries without injected spaces',
);
assert.throws(
	() => compileMarkdownTranslation(naturalParagraphPlan, [withTranslatedTexts(naturalTranslation, { [lessAttentionTextId]: '' })]),
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
			n1: { kind: 'inlineCode', reference: 'GRUB_CMDLINE_LINUX_DEFAULT' },
			n2: { kind: 'inlineCode', reference: '/etc/default/grub' },
		},
		texts: {
			t1: 'Add options to the existing ',
			t2: ' value in ',
			t3: ', then apply them with:',
		},
		sequences: {
			root: ['t1', 'n1', 't2', 'n2', 't3'],
		},
	},
	'opaque inline code must reach the model as movable references with read-only semantic previews',
);
const [settingInlineId, pathInlineId] = inlineIdsOfKind(inlineCodeTemplate, 'inlineCode');
assert.ok(settingInlineId && pathInlineId, 'inline-code fixture must expose both atoms');
const inlineCodeTranslation = withTranslatedTexts(
	withSequenceOrder(targetFromSource(inlineCodeSegment), 'root', ['t2', pathInlineId, 't1', settingInlineId, 't3']),
	{
		t1: '中，將選項加入現有的',
		t2: '請在',
		t3: '值，然後執行以下指令：',
	},
);
assert.equal(
	compileMarkdownTranslation(inlineCodePlan, [inlineCodeTranslation]),
	'請在`/etc/default/grub`中，將選項加入現有的`GRUB_CMDLINE_LINUX_DEFAULT`值，然後執行以下指令：',
	'Core must let multiple atomic inline nodes move to natural target-language positions',
);

for (const [order, message] of [
	[['t1', settingInlineId, settingInlineId, pathInlineId, 't3'], 'duplicate inline references must fail closed'],
	[['t1', settingInlineId, 't2', 't3'], 'missing inline references must fail closed'],
	[['t1', settingInlineId, 't2', pathInlineId, 't3', 'n999999'], 'unknown inline references must fail closed'],
]) {
	assert.throws(
		() => compileMarkdownTranslation(inlineCodePlan, [withSequenceOrder(inlineCodeTranslation, 'root', order)]),
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
const nestedRootTextIds = textIdsInSequence(nestedTemplate);
const nestedStrongTextId = textIdsInSequence(nestedTemplate, strongInlineId)[0];
const nestedLinkTextId = textIdsInSequence(nestedTemplate, nestedLinkInlineId)[0];
assert.equal(nestedRootTextIds.length, 3, 'nested-inline fixture must expose three root text positions');
assert.ok(nestedStrongTextId && nestedLinkTextId, 'nested-inline fixture must expose translated container text IDs');
const nestedTranslation = withTranslatedTexts(
	withSequenceOrder(targetFromSource(nestedSegment), 'root', [
		nestedRootTextIds[1],
		codeInlineId,
		nestedRootTextIds[0],
		strongInlineId,
		nestedRootTextIds[2],
	]),
	{
		[nestedRootTextIds[0]]: '前，請先閱讀',
		[nestedRootTextIds[1]]: '執行',
		[nestedRootTextIds[2]]: '。',
		[nestedStrongTextId]: '完整的',
		[nestedLinkTextId]: '研究報告',
	},
);
assert.equal(
	compileMarkdownTranslation(nestedPlan, [nestedTranslation]),
	'執行`pnpm test`前，請先閱讀**完整的[研究報告](https://example.com/report)**。',
	'nested inline containers must move as complete nodes while preserving their child scopes',
);
assert.throws(
	() =>
		compileMarkdownTranslation(nestedPlan, [
			withTranslatedTexts(nestedTranslation, { [nestedRootTextIds[0]]: '', [nestedRootTextIds[1]]: '' }),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'direct prose in a non-leaf sequence must not disappear behind translated child content',
);
assert.throws(
	() =>
		compileMarkdownTranslation(nestedPlan, [
			withSequenceOrder(nestedTranslation, 'root', [
				nestedRootTextIds[1],
				codeInlineId,
				nestedRootTextIds[0],
				nestedLinkInlineId,
				nestedRootTextIds[2],
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
assert.deepEqual(inlineHtmlTemplate.inlines, {}, 'raw inline HTML must remain entirely outside the model contract');
const inlineHtmlSequenceIds = Object.keys(inlineHtmlTemplate.sequences);
assert.deepEqual(
	inlineHtmlSequenceIds,
	['root:slot:01', 'root:slot:02', 'root:slot:03'],
	'fixed HTML anchors must deterministically split the surrounding prose',
);
const inlineHtmlTextIds = Object.fromEntries(
	inlineHtmlSequenceIds.map((sequenceId) => [sequenceId, textIdsInSequence(inlineHtmlTemplate, sequenceId)[0]]),
);
assert.ok(Object.values(inlineHtmlTextIds).every(Boolean), 'fixed HTML slots must each expose one text ID');
const inlineHtmlTranslation = withTranslatedTexts(targetFromSource(inlineHtmlSegment), {
	[inlineHtmlTextIds['root:slot:01']]: '之前',
	[inlineHtmlTextIds['root:slot:02']]: '醒目文字',
	[inlineHtmlTextIds['root:slot:03']]: '之後。',
});
assert.equal(
	compileMarkdownTranslation(inlineHtmlPlan, [inlineHtmlTranslation]),
	'之前<mark>醒目文字</mark>之後。',
	'fixed raw HTML anchors must retain translated prose inside their original slot',
);
assert.throws(
	() =>
		compileMarkdownTranslation(inlineHtmlPlan, [
			{
				...inlineHtmlTranslation,
				sequences: { 'root:slot:01': [inlineHtmlTextIds['root:slot:01']] },
			},
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'markdown-structure-changed',
	'fixed-anchor slots cannot be merged or omitted by model output',
);

const citationPlan = planMarkdownTranslation('First claim.[^a] Second claim.[^b]\n\n[^a]: First note.\n[^b]: Second note.');
const citationSegment = citationPlan.segments.find((segment) =>
	Object.keys(createMarkdownTranslationTemplate(segment).sequences).some((id) => id.startsWith('root:slot:')),
);
assert.ok(citationSegment, 'citation fixture must expose fixed-anchor translation slots');
const citationTemplate = createMarkdownTranslationTemplate(citationSegment);
assert.equal(inlineIdsOfKind(citationTemplate, 'footnoteReference').length, 0, 'footnote references must remain Core-owned');
assert.deepEqual(
	Object.keys(citationTemplate.sequences),
	['root:slot:01', 'root:slot:02'],
	'each claim must remain in its own translation slot beside its citation',
);
const citationTranslations = citationPlan.segments.map((segment) => targetFromSource(segment));
const citationIndex = citationPlan.segments.findIndex((segment) => segment.id === citationSegment.id);
assert.ok(citationIndex >= 0, 'citation segment must belong to the plan');
const citationTranslation = citationTranslations[citationIndex];
assert.ok(citationTranslation, 'citation segment must have a source translation');
citationTranslations[citationIndex] = withTranslatedTexts(citationTranslation, {
	[textIdsInSequence(citationTemplate, 'root:slot:01')[0]]: '第一項主張。',
	[textIdsInSequence(citationTemplate, 'root:slot:02')[0]]: '第二項主張。',
});
const citationMarkdown = compileMarkdownTranslation(citationPlan, citationTranslations);
assert.ok(citationMarkdown.includes('第一項主張。[^a]第二項主張。[^b]'), 'Core must restore each citation at its original claim boundary');

const formulaCitationPlan = planMarkdownTranslation(
	'The score $a$ rises to $b$.[^one] Then $c$ falls below $d$.\n\n[^one]: Supporting evidence.',
);
const formulaCitationSegment = formulaCitationPlan.segments.find((segment) =>
	Object.keys(createMarkdownTranslationTemplate(segment).sequences).some((id) => id.startsWith('root:slot:')),
);
assert.ok(formulaCitationSegment, 'formula-plus-citation regression fixture must produce fixed-anchor slots');
const formulaCitationTemplate = createMarkdownTranslationTemplate(formulaCitationSegment);
assert.equal(
	inlineIdsOfKind(formulaCitationTemplate, 'footnoteReference').length,
	0,
	'fixed footnotes must not compete with movable formulas in structured model output',
);
const formulaIdsBySlot = Object.fromEntries(
	Object.entries(formulaCitationTemplate.sequences).map(([sequenceId, parts]) => [
		sequenceId,
		parts.filter((partId) => Object.hasOwn(formulaCitationTemplate.inlines, partId)),
	]),
);
assert.deepEqual(
	Object.values(formulaIdsBySlot).map((ids) => ids.length),
	[2, 2],
	'movable formulas must stay available on both sides of the fixed citation',
);
const formulaCitationTranslations = formulaCitationPlan.segments.map((segment) => targetFromSource(segment));
const formulaCitationIndex = formulaCitationPlan.segments.findIndex((segment) => segment.id === formulaCitationSegment.id);
assert.ok(formulaCitationIndex >= 0, 'formula-plus-citation segment must belong to its plan');
const [formulaSlotOne, formulaSlotTwo] = Object.keys(formulaCitationTemplate.sequences);
const [formulaA, formulaB] = formulaIdsBySlot[formulaSlotOne] ?? [];
const [formulaC, formulaD] = formulaIdsBySlot[formulaSlotTwo] ?? [];
assert.ok(formulaSlotOne && formulaSlotTwo && formulaA && formulaB && formulaC && formulaD, 'fixture must expose all formula references');
const formulaSlotOneTextIds = textIdsInSequence(formulaCitationTemplate, formulaSlotOne);
const formulaSlotTwoTextIds = textIdsInSequence(formulaCitationTemplate, formulaSlotTwo);
assert.equal(formulaSlotOneTextIds.length, 3, 'first formula slot must expose three text positions');
assert.equal(formulaSlotTwoTextIds.length, 3, 'second formula slot must expose three text positions');
formulaCitationTranslations[formulaCitationIndex] = withTranslatedTexts(formulaCitationTranslations[formulaCitationIndex], {
	[formulaSlotOneTextIds[0]]: '得分',
	[formulaSlotOneTextIds[1]]: '上升至',
	[formulaSlotOneTextIds[2]]: '。',
	[formulaSlotTwoTextIds[0]]: '接著',
	[formulaSlotTwoTextIds[1]]: '降至',
	[formulaSlotTwoTextIds[2]]: '。',
});
const formulaCitationMarkdown = compileMarkdownTranslation(formulaCitationPlan, formulaCitationTranslations);
assert.ok(
	formulaCitationMarkdown.includes('得分$a$上升至$b$。[^one]接著$c$降至$d$。'),
	'formulas may follow target-language order within each slot while Core keeps the citation boundary fixed',
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
