import assert from 'node:assert/strict';

const { MarkdownTranslationInvariantError, compileMarkdownTranslation, planMarkdownTranslation, validateMarkdownBatchTranslations } =
	await import('../src/ingest/markdown-translation.ts');

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

[^source]: Footnote prose with a [reference][docs].

[docs]: https://example.com/docs "Documentation title"
`;

const options = {
	maxBatchCharacters: 320,
	maxBatchSegments: 4,
	maxContextCharacters: 48,
	maxSegmentCharacters: 120,
};
const plan = planMarkdownTranslation(markdownFixture, options);
assert.ok(plan.segments.length > 10, 'fixture should produce independently addressable prose segments');
assert.ok(plan.batches.length > 1, 'fixture should exercise deterministic batching');
assert.deepEqual(planMarkdownTranslation(markdownFixture, options), plan, 'translation planning must be deterministic');
const blockCounts = new Map();
for (const segment of plan.segments) {
	const block = segment.context?.match(/^Block: (b\d+)/)?.[1];
	if (block) blockCounts.set(block, (blockCounts.get(block) ?? 0) + 1);
	assert.ok(!segment.context?.includes('Block: Read the'), 'block context must not repeat source prose');
}
assert.ok(
	[...blockCounts.values()].some((count) => count >= 3),
	'inline Markdown fragments must retain a shared prose block',
);
for (const opaqueValue of [
	'Opaque frontmatter metadata',
	'C_L',
	'E = mc^2',
	'Original title',
	'https://example.com/report?q=1',
	'pnpm test',
	'protected_code',
	'Opaque HTML must stay untouched.',
]) {
	assert.ok(
		plan.segments.every((segment) => !segment.text.includes(opaqueValue)),
		`opaque value crossed the translatable segment boundary: ${opaqueValue}`,
	);
}
for (const batch of plan.batches) {
	assert.ok(batch.inputCharacters <= options.maxBatchCharacters, `${batch.id} exceeded its input character budget`);
}

const translations = plan.segments.map((segment, index) => ({
	id: segment.id,
	text: `譯文${index + 1}：星號 *、括號 [、井字號 # 與反斜線 \\ 都只是文字`,
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
	longPlan.segments
		.map((segment) => segment.text)
		.join('')
		.replaceAll(' ', ''),
	longMarkdown.replace(/^# /, '').replaceAll('\n', '').trim().replaceAll(' ', ''),
	'long prose segmentation must not drop content',
);

console.info({
	batchCount: plan.batches.length,
	event: 'markdown_translation_contract_passed',
	longBodyBatchCount: longPlan.batches.length,
	segmentCount: plan.segments.length,
});
