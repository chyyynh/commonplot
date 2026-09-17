import assert from 'node:assert/strict';
import { fromHtml } from 'hast-util-from-html';
import { normalizeExtractedPdfMarkdown } from '../src/ingest/extracted-pdf-markdown.ts';
import {
	MarkdownTranslationInvariantError,
	compileMarkdownTranslationArtifact,
	planMarkdownTranslation,
} from '../src/ingest/markdown-translation.ts';

const compileMarkdownTranslation = (...args) => compileMarkdownTranslationArtifact(...args).content;
function targetFromSource(segment, translate = (text) => text) {
	return {
		texts: Object.fromEntries(Object.entries(segment.template.texts).map(([id, text]) => [id, translate(text)])),
	};
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

const nestedCaptionPlan = planMarkdownTranslation('_**Figure.** Caption _Notes_: details._');
const nestedCaption = compileMarkdownTranslationArtifact(
	nestedCaptionPlan,
	nestedCaptionPlan.segments.map((segment) => targetFromSource(segment, () => '譯文')),
);
assert.match(nestedCaption.content, /_譯文_/, 'nested emphasis uses a distinct delimiter after translation');

for (const marker of ['**', '*', '~~']) {
	const whitespaceSource = `| Metric | Existing LLMs |\n| --- | --- |\n| Speed | **Response time:**[**3 seconds**](https://example.com/benchmark)${marker}&#x20;${marker}&#x66;or frontier models. |`;
	const whitespacePlan = planMarkdownTranslation(whitespaceSource);
	const translate = (text) =>
		text
			.replace('Metric', '指標')
			.replace('Existing LLMs', '現有模型')
			.replace('Speed', '速度')
			.replace('Response time:', '回應時間：')
			.replace('3 seconds', '3 秒')
			.replace('for frontier models.', '（以前沿模型而言）。');
	const whitespaceArtifact = compileMarkdownTranslationArtifact(
		whitespacePlan,
		whitespacePlan.segments.map((segment) => targetFromSource(segment, (text) => (text.trim() ? translate(text) : ''))),
	);
	assert.equal(
		whitespaceArtifact.content,
		planMarkdownTranslation(translate(whitespaceSource.replace('&#x66;', 'f'))).sourceMarkdown,
		'whitespace-only formatting survives translation even when the model removes unnecessary spaces',
	);
	assert.deepEqual(whitespaceArtifact.alignment.paths, [
		[0, 0, 0],
		[0, 0, 1],
		[0, 1, 0],
		[0, 1, 1],
	]);
}

const referencePlan = planMarkdownTranslation(
	'## Introduction\n\nRead [the report][docs], [shortcut] and ![chart][image].\n\n> [docs]: https://example.com/report "Report"\n\n[image]: https://example.com/chart.png\n\n[shortcut]: https://example.com/shortcut',
);
const referenceArtifact = compileMarkdownTranslationArtifact(
	referencePlan,
	referencePlan.segments.map((segment) => targetFromSource(segment, (text) => `譯文 ${text}`)),
);
assert.deepEqual(referenceArtifact.alignment.paths[0], [0], 'The first heading has a native Markdown path');
assert.match(referenceArtifact.content, /\[docs\]: https:\/\/example.com\/report/u);
assert.match(referenceArtifact.content, /\[image\]: https:\/\/example.com\/chart.png/u);

const plan = planMarkdownTranslation(markdownFixture, { maxBatchCharacters: 900, maxBatchSegments: 4 });
const identity = plan.segments.map((segment) => targetFromSource(segment));
assert.equal(compileMarkdownTranslation(plan, identity), plan.sourceMarkdown);
assert.throws(() => compileMarkdownTranslation(plan, identity.slice(1)), MarkdownTranslationInvariantError);
const empty = plan.segments.map((segment) => targetFromSource(segment, () => ''));
assert.throws(() => compileMarkdownTranslation(plan, empty), MarkdownTranslationInvariantError);
const literalPlan = planMarkdownTranslation('Read \\<n1> with **bold** text.');
assert.equal(
	compileMarkdownTranslation(
		literalPlan,
		literalPlan.segments.map((segment) => targetFromSource(segment)),
	),
	literalPlan.sourceMarkdown,
);
assert.equal(
	compileMarkdownTranslation(
		literalPlan,
		literalPlan.segments.map((segment) => targetFromSource(segment, (text) => text.replace('Read', 'Keep <n2>'))),
	),
	planMarkdownTranslation('Keep \\<n2> \\<n1> with **bold** text.').sourceMarkdown,
	'literal source and translated text cannot become internal formatting markers',
);
const translated = compileMarkdownTranslation(
	plan,
	plan.segments.map((segment) =>
		targetFromSource(segment, (text) => text.replace('research report', '研究報告').replace('Footnote prose', '註腳文字')),
	),
);
assert.match(translated, /\[研究報告\]\(https:\/\/example.com\/report\?q=1/u);
assert.match(translated, /\[\^source\]: 註腳文字/u);
for (const value of ['C_L', 'E = mc^2', 'pnpm test', 'user@example.com', '$57', '$60', 'const markdown = "**not translated**";']) {
	assert.ok(translated.includes(value), `Protected Markdown changed: ${value}`);
}
const longSource = Array.from(
	{ length: 100 },
	(_, i) => `Paragraph ${i} has a [source](https://example.com/${i}) and **important** text.`,
).join('\n\n');
const longPlan = planMarkdownTranslation(longSource, { maxBatchSegments: 4 });
assert.ok(longPlan.batches.length > 1);
assert.equal(
	compileMarkdownTranslation(
		longPlan,
		longPlan.segments.map((segment) => targetFromSource(segment)),
	),
	longPlan.sourceMarkdown,
);

const tableSource = normalizeExtractedPdfMarkdown(`Before[^evidence].

<table><caption>Results</caption><thead><tr><th colspan="2" scope="colgroup">Metric</th></tr></thead><tbody>
<tr><th rowspan="2" scope="row">Condition</th><td><p>The <strong>best</strong> result[^evidence] with <a href="https://example.com/source?q=1&amp;b=2">source</a>.</p><p>Price $5 to $10 is approximate.</p><p>First line

Second line</p><ul><li>*literal* [plain](text)</li></ul></td></tr>
<tr><td><pre><code>if (a &lt; b) return \`x\`;

[^evidence] is code</code></pre><p>$x &lt; y$</p><p>$$
E = mc^2
$$</p></td></tr></tbody></table>

After[^evidence].

[^evidence]: Original evidence.`);
const htmlPlan = planMarkdownTranslation(tableSource);
const modelTexts = htmlPlan.segments.map((segment) => segment.template.texts);
const tableModelText = JSON.stringify(modelTexts);
assert.match(tableModelText, /Price \$5 to \$10/u, 'prices remain translatable prose, not protected formulas');
assert.doesNotMatch(tableModelText, /E = mc|x < y|return|rowspan|colspan|https:\/\/example.com|\[\^evidence\]/u);
const tableArtifact = compileMarkdownTranslationArtifact(
	htmlPlan,
	htmlPlan.segments.map((segment) =>
		targetFromSource(segment, (value) =>
			value
				.replace('Results', '結果')
				.replace('Metric', '指標')
				.replace('Condition', '條件')
				.replace('best', '最好')
				.replace('result', '結果'),
		),
	),
);
const identityTable = compileMarkdownTranslation(
	htmlPlan,
	htmlPlan.segments.map((segment) => targetFromSource(segment)),
);
assert.equal(identityTable, htmlPlan.sourceMarkdown, 'identity translation must preserve canonical tables byte-for-byte');
function htmlNodes(node) {
	return [node, ...('children' in node ? node.children.flatMap(htmlNodes) : [])];
}
function tableStructure(markdown) {
	return htmlNodes(fromHtml(markdown, { fragment: true }))
		.filter((node) => node.type === 'element')
		.map(({ tagName, properties }) => ({ tagName, properties }));
}
assert.deepEqual(
	tableStructure(tableArtifact.content),
	tableStructure(htmlPlan.sourceMarkdown),
	'translation preserves every table tag and attribute',
);
assert.match(tableArtifact.content, /\*\*最好\*\* 結果\[\^evidence\]/u);
assert.ok(tableArtifact.content.includes('return `x`;\n\n[^evidence] is code'));
assert.ok(tableArtifact.content.includes('$$\nE = mc^2\n$$'));
assert.ok(tableArtifact.content.includes('First line\nSecond line'));
assert.equal(tableArtifact.alignment.version, 2);
assert.ok(tableArtifact.alignment.paths.length > 0, 'HTML cell content has native Markdown paths');
const injectedTable = compileMarkdownTranslation(
	htmlPlan,
	htmlPlan.segments.map((segment) => targetFromSource(segment, (value) => value.replace('Metric', '<img src=x onerror=alert(1)>'))),
);
assert.ok(injectedTable.includes('\\<img src=x onerror=alert(1)>'), 'model output remains escaped Markdown text');
console.info(
	'HTML table translation passed: spans, headers, captions, notes, code, math, currency, literal text, alignment and injection.',
);

import { registerHooks } from 'node:module';
import { PgDialect } from 'drizzle-orm/pg-core';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'cloudflare:workers')
			return { shortCircuit: true, url: 'data:text/javascript,export class WorkflowEntrypoint {constructor(_ctx,env){this.env=env;}}' };
		if (specifier === 'cloudflare:workflows')
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		if (context.parentURL?.endsWith('/ingest/translation-workflow.ts') && specifier === '../shared/db') {
			return {
				shortCircuit: true,
				url: 'data:text/javascript,export const connectCoreDb = (...args) => globalThis.translationWorkflowContract.connectCoreDb(...args);',
			};
		}
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/workers/core-worker/src/'))
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		return nextResolve(specifier, context);
	},
});
const { enqueueResourceTranslation, ResourceTranslationV2Workflow, shouldEnqueueResourceTranslation } =
	await import('../src/ingest/translation-workflow.ts');
const candidate = (overrides = {}) => ({
	fileType: 'application/pdf',
	kind: 'paper',
	originalLang: 'en',
	resourcePlatform: null,
	scope: 'corpus',
	url: 'https://doi.org/10.1000/example',
	...overrides,
});

assert.equal(shouldEnqueueResourceTranslation(candidate()), true, 'canonical PDF papers must be translated');
assert.equal(
	shouldEnqueueResourceTranslation(candidate({ kind: 'file', scope: 'private', url: null })),
	true,
	'private uploaded PDFs must remain translatable before canonicalization',
);
assert.equal(shouldEnqueueResourceTranslation(candidate({ kind: 'file' })), false, 'corpus PDF files are not papers');
assert.equal(shouldEnqueueResourceTranslation(candidate({ originalLang: 'zh-Hant' })), false, 'target-language papers need no translation');
assert.equal(
	shouldEnqueueResourceTranslation(candidate({ resourcePlatform: 'youtube' })),
	false,
	'platform carriers cannot enter the platformless PDF path',
);
assert.equal(
	shouldEnqueueResourceTranslation(candidate({ fileType: null, kind: 'blog', url: 'https://example.com/article' })),
	true,
	'ordinary corpus resources remain translatable',
);

console.info({ event: 'translation_policy_contract_smoke_passed' });

const queued = [];
const registered = [];
const parent = (taskId, required = true) => ({ taskId, required });
const statuses = new Map();
let unavailable = false;
const env = {
	APP: {
		registerResourceProgressTask: async (input) => {
			registered.push(input);
			return true;
		},
	},
	RESOURCE_TRANSLATION_V2_WORKFLOW: {
		get: async (id) => {
			if (unavailable || !statuses.has(id)) throw new Error('unavailable');
			return { status: async () => (typeof statuses.get(id) === 'string' ? { status: statuses.get(id) } : statuses.get(id)) };
		},
		createBatch: async (instances) => {
			queued.push(...instances);
			for (const instance of instances) if (!statuses.has(instance.id)) statuses.set(instance.id, 'queued');
			return instances;
		},
	},
};
const resourceId = '8d2e4a53-23e1-4dab-a26b-6c762f427114';
const revision = 'a'.repeat(32);
const shared = await enqueueResourceTranslation(env, resourceId, revision, undefined, parent('first-import'));
unavailable = true;
assert.equal(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, parent('second-import')),
	shared,
	'unavailable control plane must not duplicate a shared translation',
);
unavailable = false;
statuses.set(shared, 'errored');
const retry = await enqueueResourceTranslation(env, resourceId, revision, undefined, parent('retry-import'));
assert.notEqual(retry, shared, 'explicit processing retry must recover a failed unchanged translation');
assert.equal(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, parent('retry-import')),
	retry,
	'durable enqueue retries use the same physical task',
);
assert.equal(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, parent('later-retry-import')),
	retry,
	'concurrent imports must share the active retry generation',
);
statuses.set(retry, 'terminated');
assert.notEqual(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, parent('later-retry-import')),
	retry,
	'a failed retry generation can itself be recovered',
);
assert.equal(
	queued.every(({ params }) => params.force === undefined),
	true,
	'retry preserves existing human/complete fields through the normal translation plan',
);
console.info({ event: 'translation_retry_contract_passed', cases: 6 });

const automaticRevision = 'b'.repeat(32);
const automatic = await enqueueResourceTranslation(env, resourceId, automaticRevision, undefined, parent('source-draft', false));
assert.deepEqual(registered.at(-1), { taskId: automatic, kind: 'translation', resourceId });
assert.equal('progress' in queued.at(-1).params, false);
assert.equal(await enqueueResourceTranslation(env, resourceId, automaticRevision, undefined, parent('late-user')), automatic);
assert.equal(registered.at(-1).parentTaskId, 'late-user', 'a later user attaches to the original shared ledger');
statuses.set(automatic, 'complete');
const creationCount = queued.length;
assert.equal(await enqueueResourceTranslation(env, resourceId, automaticRevision, undefined, parent('late-complete')), automatic);
assert.equal(queued.length, creationCount, 'completed work does not rerun a provider');
assert.equal(registered.at(-1).parentTaskId, 'late-user', 'completed work creates no new subscription or queued ledger');
await assert.rejects(
	enqueueResourceTranslation(
		{ ...env, APP: { registerResourceProgressTask: async () => false } },
		resourceId,
		'c'.repeat(32),
		undefined,
		parent('missing-parent'),
	),
	/registration was rejected/,
);
assert.equal(queued.length, creationCount, 'failed registration cannot admit paid work');
console.info({ event: 'shared_translation_ledger_contract_passed' });

// Execute the actual translation Workflow with provider/DB boundaries controlled.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error('Translation contract attempted an external provider request');
};
try {
	for (const scenario of [
		'app-unavailable',
		'index-unavailable',
		'progress-unavailable',
		'complete',
		'parallel',
		'parallel-failure',
		'rate-limited',
		'format-recovery',
		'metadata-parallel',
	]) {
		const parallel = scenario.startsWith('parallel');
		const effects = [];
		const appCalls = [];
		let reads = 0;
		let active = 0;
		let peak = 0;
		let persistedContent;
		const providerBatches = [];
		const retryDelays = [];
		let metadataActive = false;
		globalThis.translationWorkflowContract = {
			connectCoreDb: async () => ({
				execute: async (query) => {
					reads++;
					if (reads > 1) {
						persistedContent = new PgDialect()
							.sqlToQuery(query)
							.params.find((value) => typeof value === 'string' && value.startsWith('譯文'));
						effects.push('persisted');
						return { rows: [{ resource_id: resourceId }] };
					}
					return {
						rows: [
							{
								id: resourceId,
								file_type: 'application/pdf',
								kind: 'paper',
								resource_platform: null,
								original_lang: 'en',
								scope: 'corpus',
								title: 'A research paper',
								summary: null,
								content:
									scenario === 'format-recovery' || scenario === 'rate-limited'
										? Array.from({ length: 8 }, (_, index) => `A long research paragraph ${index} requires complete translation.`).join(
												'\n\n',
											)
										: parallel
											? Array.from(
													{ length: 496 },
													(_, index) => `Original research paragraph number ${index + 1} requires translation.`,
												).join('\n\n')
											: 'This is the original readable content of a research paper that requires translation.',
								zh_hant_title: scenario === 'metadata-parallel' ? null : '研究論文',
								zh_hant_summary: null,
								zh_hant_content: null,
								zh_hant_alignment_version: null,
								zh_hant_source: 'machine',
								translation_revision: revision,
								url: 'https://example.com/paper.pdf',
							},
						],
					};
				},
			}),
		};
		const app = Object.fromEntries(
			['startResourceProgressTask', 'reportResourceProgress', 'registerResourceProgressTask', 'sealResourceProgressTask'].map((name) => [
				name,
				async (input) => {
					if (name === 'sealResourceProgressTask') {
						assert.equal(active, 0, 'all provider work must settle before sealing');
						assert.equal(metadataActive, false);
					}
					appCalls.push({ name, input });
					if (
						scenario === 'app-unavailable' ||
						(scenario === 'progress-unavailable' && name === 'reportResourceProgress' && input.status === 'complete')
					)
						throw new Error('APP unavailable');
					return true;
				},
			]),
		);
		const workflow = new ResourceTranslationV2Workflow(
			{},
			{
				APP: app,
				AI: {
					run: async (_model, inputs, options) => {
						if (options.gateway.metadata.feature === 'resource-metadata-localization') {
							metadataActive = true;
							effects.push('metadata-start');
							await new Promise((resolve) => setTimeout(resolve, 60));
							metadataActive = false;
							effects.push('metadata-end');
							return { response: JSON.stringify({ title: '研究論文' }) };
						}
						const batch = {
							id: options.gateway.metadata.batch_id,
							...JSON.parse(inputs.messages.find((message) => message.role === 'user').content),
						};
						effects.push('provider');
						providerBatches.push(batch.id);
						effects.push('body-start');
						if (scenario === 'rate-limited' && providerBatches.length <= 3) throw new Error('429 rate limit');
						if (scenario === 'format-recovery') {
							if (batch.id === 'b0001' || batch.id === 'b0001-2') return { response: 'Malformed model output' };
							if (batch.id === 'b0001-2-1' && providerBatches.filter((id) => id === batch.id).length <= 2)
								throw new Error('429 rate limit');
						}
						active++;
						peak = Math.max(peak, active);
						// Complete out of source order, with more than two full concurrency windows.
						await new Promise((resolve) => setTimeout(resolve, batch.id === 'b0001' ? 30 : 1));
						active--;
						effects.push('body-end');
						if (scenario === 'parallel-failure' && batch.id === 'b0002') throw new Error('Provider exhausted retries');
						return {
							response: JSON.stringify({
								translations: Object.fromEntries(
									batch.segments.map((segment) => [
										segment.id,
										{
											texts: Object.fromEntries(
												Object.values(segment.sequences)
													.flat()
													.filter((part) => 'text' in part)
													.map((part) => [part.id, parallel ? `譯文 ${segment.id}` : '這是一篇研究論文的可讀原始內容，需要完整翻譯。']),
											),
										},
									]),
								),
							}),
						};
					},
				},
				RESOURCE_SEARCH_SYNC_QUEUE: {
					send: async (body) => {
						assert.equal(body.resourceId, resourceId);
						assert.ok(body.taskId, 'translation indexing registers a child task');
						if (scenario === 'index-unavailable') throw new Error('Queue unavailable');
						effects.push('indexed');
					},
				},
			},
		);
		const result = workflow.run(
			{
				instanceId: 'shared-translation-contract',
				payload: { resourceId, translationRevision: revision },
			},
			{
				do: async (_name, ...args) => {
					for (let attempt = 1; ; attempt++) {
						try {
							return await args.at(-1)({ attempt });
						} catch (error) {
							if (!['rate-limited', 'format-recovery'].includes(scenario) || attempt > args[0].retries.limit) throw error;
							assert.equal(args[0].retries.backoff, 'constant', 'Workflow backoff must not multiply the dynamic retry delay');
							retryDelays.push(args[0].retries.delay({ ctx: { attempt }, error }));
						}
					}
				},
			},
		);
		if (scenario === 'app-unavailable') {
			await assert.rejects(result, /APP unavailable/);
			assert.deepEqual(effects, [], 'progress admission gates paid provider execution');
		} else if (scenario === 'parallel-failure') {
			await assert.rejects(result, /Provider exhausted retries/);
			assert.equal(effects.includes('persisted'), false, 'a failed batch cannot publish a partial translation');
			assert.equal(peak, 15);
		} else {
			if (['index-unavailable', 'progress-unavailable'].includes(scenario)) await assert.rejects(result);
			else assert.deepEqual(await result, { status: 'complete', resourceId });
			assert.equal(effects.includes('indexed'), scenario !== 'index-unavailable');
			assert.ok(effects.includes('provider') && effects.includes('persisted'));
			const outcomes = appCalls.filter(({ name }) => name === 'reportResourceProgress').map(({ input }) => input);
			assert.ok(outcomes.some(({ status }) => status === 'complete'));
			assert.ok(
				outcomes.every(({ errorCode }) => errorCode === undefined),
				'index handoff failure does not fail published content',
			);
			if (scenario === 'metadata-parallel') {
				assert.ok(effects.indexOf('body-start') < effects.indexOf('metadata-end'));
				assert.ok(effects.indexOf('metadata-start') < effects.indexOf('body-end'), 'metadata and body must overlap');
			}
			if (scenario === 'rate-limited') {
				assert.deepEqual(
					providerBatches,
					Array.from({ length: 4 }, () => 'b0001'),
					'rate limits never split batches',
				);
				assert.deepEqual(retryDelays, [60000, 120000, 180000]);
			}
			if (scenario === 'format-recovery') {
				assert.equal(providerBatches.filter((id) => id === 'b0001-1').length, 1, 'successful halves are not translated twice');
				assert.deepEqual(retryDelays, [60000, 120000]);
			}
			if (parallel) {
				assert.equal(peak, 15, 'translation must use, and never exceed, 15 concurrent batches');
				assert.equal(effects.filter((effect) => effect === 'provider').length, 31, 'every batch runs exactly once');
				assert.deepEqual(
					outcomes.filter(({ completed }) => completed !== undefined).map(({ completed }) => completed),
					Array.from({ length: 32 }, (_, index) => index),
					'progress must remain monotonic despite out-of-order batches',
				);
				assert.equal(
					persistedContent.trim(),
					Array.from({ length: 496 }, (_, index) => `譯文 s${String(index + 1).padStart(6, '0')}`).join('\n\n'),
					'persisted translation must retain original segment order',
				);
			}
		}
	}
} finally {
	globalThis.fetch = originalFetch;
	delete globalThis.translationWorkflowContract;
}
console.info({ event: 'translation_workflow_outage_and_concurrency_contract_passed', cases: 8 });

// The same policy also runs in workerd with native durable steps and a rejecting
// service-binding entrypoint. Isolated local config never loads project secrets.
const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
process.env.WRANGLER_LOG_PATH = join(tmpdir(), `opennews-task-runtime-${process.pid}.log`);
const { unstable_dev } = await import('wrangler');
const directory = await mkdtemp(join(tmpdir(), 'opennews-task-runtime-'));
let runtime;
try {
	const entry = join(directory, 'worker.ts');
	const config = join(directory, 'wrangler.json');
	await writeFile(
		entry,
		`
import {WorkflowEntrypoint,WorkerEntrypoint} from 'cloudflare:workers';
import {createResourceTask,registerResourceTask,enqueueSearchProgress} from ${JSON.stringify(fileURLToPath(new URL('../src/ingest/progress.ts', import.meta.url)))};
export class UnavailableApp extends WorkerEntrypoint {
 async startResourceProgressTask(){throw new Error('APP start unavailable');}
 async reportResourceProgress(){throw new Error('APP report unavailable');}
 async registerResourceProgressTask(){throw new Error('APP register unavailable');}
 async sealResourceProgressTask(){throw new Error('APP seal unavailable');}
}
export class TaskFixture extends WorkflowEntrypoint {
 async run(event,step){
  const taskEnv={...this.env,RESOURCE_SEARCH_SYNC_QUEUE:{send:async body=>{if(body.taskId)throw new Error('Untracked child task');}}};
  const immediateStep={do:(name,config,callback)=>step.do(name,{...config,retries:{limit:0,delay:'1 second'}},callback)};
  const task=createResourceTask(taskEnv,immediateStep,event.instanceId,event.payload.tracked);
  await task.start('acquiring');
  const persisted=await step.do('provider-and-persist',async()=>({resourceId:${JSON.stringify(resourceId)}}));
  await task.report('complete',{status:'complete',resourceId:persisted.resourceId});
  await registerResourceTask(taskEnv,{taskId:'child',kind:'translation'},task);
  await enqueueSearchProgress(taskEnv,persisted.resourceId,task,'revision');
  await task.seal();
  return {status:'complete',resourceId:persisted.resourceId};
 }
}
export default {async fetch(request,env){
 const path=new URL(request.url).pathname.slice(1);
 if(request.method==='POST'){await env.TASK.create({id:path,params:{tracked:path==='tracked'}});return Response.json({id:path});}
 return Response.json(await (await env.TASK.get(path)).status());
}};
`,
	);
	await writeFile(
		config,
		JSON.stringify({
			name: 'opennews-task-runtime-fixture',
			compatibility_date: '2026-09-01',
			compatibility_flags: ['nodejs_compat'],
			workflows: [{ binding: 'TASK', name: 'task-fixture', class_name: 'TaskFixture' }],
			services: [{ binding: 'APP', service: 'opennews-task-runtime-fixture', entrypoint: 'UnavailableApp' }],
		}),
	);
	runtime = await unstable_dev(entry, {
		config,
		local: true,
		port: 0,
		persist: false,
		logLevel: 'error',
		experimental: { disableDevRegistry: true, disableExperimentalWarning: true, watch: false, enableContainers: false },
	});
	for (const delivery of ['untracked', 'tracked']) {
		const response = await runtime.fetch(`/${delivery}`, { method: 'POST' });
		assert.equal(response.status, 200, await response.clone().text());
		const deadline = Date.now() + 25_000;
		let snapshot;
		do {
			snapshot = await (await runtime.fetch(`/${delivery}`)).json();
			if (['complete', 'errored'].includes(snapshot.status)) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		} while (Date.now() < deadline);
		assert.equal(snapshot.status, delivery === 'tracked' ? 'errored' : 'complete', JSON.stringify(snapshot));
		if (delivery === 'untracked') assert.deepEqual(snapshot.output, { status: 'complete', resourceId });
	}
	console.info({ event: 'resource_task_native_workflow_outage_passed', cases: 2 });
} finally {
	await runtime?.stop();
	await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
