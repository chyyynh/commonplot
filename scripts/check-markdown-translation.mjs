import assert from 'node:assert/strict';

const {
	MarkdownTranslationInvariantError,
	compileMarkdownTranslation,
	compileMarkdownTranslationChunks,
	createMarkdownTranslationChunkTemplate,
	planMarkdownTranslation,
	validateMarkdownBatchTranslations,
} = await import('../src/ingest/markdown-translation.ts');

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
		plan.segments.every((segment) => !segment.text.includes(hiddenDestination) && !segment.context?.includes(hiddenDestination)),
		`protected destination leaked into model input: ${hiddenDestination}`,
	);
}
for (const batch of plan.batches) {
	assert.ok(batch.inputCharacters <= options.maxBatchCharacters, `${batch.id} exceeded its input character budget`);
}

const translations = plan.segments.map((segment) => ({
	id: segment.id,
	text: segment.text
		.replace('Format-safe translation', '格式安全翻譯')
		.replace('research report', '研究報告')
		.replace('A descriptive chart', '描述性圖表')
		.replace('Footnote prose', '註腳文字'),
}));
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
		validateMarkdownBatchTranslations(firstBatch, [{ id: 'unknown', text: '未知' }, ...translations.slice(1, firstBatch.segments.length)]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'unknown-segment',
	'unknown segment IDs must fail closed',
);
assert.throws(
	() =>
		validateMarkdownBatchTranslations(firstBatch, [
			{ ...translations[0], text: ` ${translations[0].text}` },
			...translations.slice(1, firstBatch.segments.length),
		]),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'leading or trailing model whitespace must fail closed',
);
assert.throws(
	() =>
		validateMarkdownBatchTranslations(firstBatch, [
			{ ...translations[0], text: '第一段\n\n意外的新段落' },
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
const protectedToken = linkSegment.text.match(/<\/?n-[0-9]{6}>|<n-[0-9]{6}\/>/u)?.[0];
assert.ok(protectedToken, 'complete prose blocks must protect inline Markdown with opaque tokens');
assert.ok(translatedMarkdown.includes('[研究報告](https://example.com/report?q=1'), 'translated link label must keep its destination');
const linkTranslations = linkBatch.segments.map((segment) => ({
	id: segment.id,
	text: segment.id === linkSegment.id ? segment.text.replace(protectedToken, 'BROKEN') : segment.text,
}));
assert.throws(
	() => validateMarkdownBatchTranslations(linkBatch, linkTranslations),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'markdown-structure-changed',
	'changed inline tokens must fail closed',
);

const reorderedPlan = planMarkdownTranslation('The market [expects](https://example.com/forecast) electric vehicles.');
const reorderedSegment = reorderedPlan.segments[0];
assert.ok(reorderedSegment, 'reordered-inline fixture must produce one complete prose block');
const reorderedInline = reorderedSegment.protectedInlines[0];
assert.ok(reorderedInline?.kind === 'container', 'reordered-inline fixture must protect its link as a container');
assert.deepEqual(
	createMarkdownTranslationChunkTemplate(reorderedSegment),
	{
		boundaries: [
			{ edge: 'open', slot: 1 },
			{ edge: 'close', slot: 1 },
		],
		chunks: ['The market ', 'expects', ' electric vehicles.'],
	},
	'model input must describe inline boundaries without exposing structural tokens',
);
const reorderedMarkdown = compileMarkdownTranslation(reorderedPlan, [
	compileMarkdownTranslationChunks(reorderedSegment, ['', '預期', '市場將以電動車為主。']),
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
const naturalParagraphMarkdown = compileMarkdownTranslation(naturalParagraphPlan, [
	compileMarkdownTranslationChunks(naturalParagraphSegment, [
		'這類裝置會',
		'減少對注意力的要求',
		'，目前包括 Garmin ',
		'Cirqa',
		'、',
		'Fitbit Air',
		'，以及',
		'Whoop 系列',
		'。',
	]),
]);
assert.ok(
	naturalParagraphMarkdown.includes(
		'這類裝置會[減少對注意力的要求](https://example.com/less)，目前包括 Garmin [Cirqa](https://example.com/cirqa)、[Fitbit Air](https://example.com/fitbit)，以及*Whoop 系列*。',
	),
	'whole-paragraph reconstruction must preserve natural Chinese punctuation and link boundaries without injected spaces',
);
assert.throws(
	() => compileMarkdownTranslationChunks(naturalParagraphSegment, ['少一個文字槽']),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'model output must preserve the exact number of structural text slots',
);
assert.throws(
	() => compileMarkdownTranslationChunks(naturalParagraphSegment, Array(9).fill('')),
	(error) => error instanceof MarkdownTranslationInvariantError && error.code === 'invalid-result',
	'model output must not erase all prose while Core restores the structure',
);

const inlineCodePlan = planMarkdownTranslation(
	'Add options to the existing `GRUB_CMDLINE_LINUX_DEFAULT` value in `/etc/default/grub`, then apply them with:',
);
const inlineCodeSegment = inlineCodePlan.segments[0];
assert.ok(inlineCodeSegment, 'inline-code fixture must produce a segment');
assert.deepEqual(
	createMarkdownTranslationChunkTemplate(inlineCodeSegment),
	{
		boundaries: [
			{ edge: 'atom', reference: 'GRUB_CMDLINE_LINUX_DEFAULT', slot: 1 },
			{ edge: 'atom', reference: '/etc/default/grub', slot: 2 },
		],
		chunks: ['Add options to the existing ', ' value in ', ', then apply them with:'],
	},
	'opaque inline code must reach the model as positional boundaries with read-only semantic references',
);
assert.equal(
	compileMarkdownTranslation(inlineCodePlan, [
		compileMarkdownTranslationChunks(inlineCodeSegment, ['將選項加入現有的', '值；該值位於', '，然後執行以下指令：']),
	]),
	'將選項加入現有的`GRUB_CMDLINE_LINUX_DEFAULT`值；該值位於`/etc/default/grub`，然後執行以下指令：',
	'Core must restore multiple atomic inline nodes while the translation preserves their semantic roles',
);

const malformedMarkdown = `## Malformed but parseable\n\nAn **unclosed delimiter and a [broken link label must remain ordinary prose.`;
const malformedPlan = planMarkdownTranslation(malformedMarkdown);
const malformedTranslation = compileMarkdownTranslation(
	malformedPlan,
	malformedPlan.segments.map((segment) => ({ id: segment.id, text: '仍然是安全的普通文字' })),
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
		longPlan.segments.map((segment) => ({ id: segment.id, text: segment.text })),
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
