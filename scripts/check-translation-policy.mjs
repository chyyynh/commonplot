import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { PgDialect } from 'drizzle-orm/pg-core';
import { shouldEnqueueResourceTranslation } from '../src/ingest/translation-policy.ts';

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

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'cloudflare:workers')
			return { shortCircuit: true, url: 'data:text/javascript,export class WorkflowEntrypoint {constructor(_ctx,env){this.env=env;}}' };
		if (specifier === 'cloudflare:workflows')
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		if (
			context.parentURL?.endsWith('/ingest/translation-workflow.ts') &&
			(specifier === '../shared/db' || specifier === './markdown-translation-model')
		) {
			const exports =
				specifier === './markdown-translation-model'
					? `export { isMarkdownTranslationFormatError, splitSegmentsInHalf } from ${JSON.stringify(new URL('../src/ingest/markdown-translation-model.ts', import.meta.url).href)};`
					: '';
			const name = specifier === '../shared/db' ? 'connectCoreDb' : 'translateMarkdownBatchToZhHant';
			return {
				shortCircuit: true,
				url: `data:text/javascript,${encodeURIComponent(`${exports} export const ${name} = (...args) => globalThis.translationWorkflowContract.${name}(...args);`)}`,
			};
		}
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/workers/core-worker/src/'))
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		return nextResolve(specifier, context);
	},
});
const { enqueueResourceTranslation, ResourceTranslationV2Workflow } = await import('../src/ingest/translation-workflow.ts');
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
const { createMarkdownTranslationTemplate, MarkdownTranslationInvariantError } = await import('../src/ingest/markdown-translation.ts');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error('Translation contract attempted an external provider request');
};
try {
	for (const scenario of [
		'app-unavailable',
		'index-unavailable',
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
			translateMarkdownBatchToZhHant: async (batch) => {
				effects.push('provider');
				providerBatches.push(batch.id);
				effects.push('body-start');
				if (scenario === 'rate-limited' && providerBatches.length <= 3) throw new Error('429 rate limit');
				if (scenario === 'format-recovery') {
					if (batch.id === 'b0001' || batch.id === 'b0001-2') throw new MarkdownTranslationInvariantError('invalid-result', 'Bad format');
					if (batch.id === 'b0001-2-1' && providerBatches.filter((id) => id === batch.id).length <= 2) throw new Error('429 rate limit');
				}
				active++;
				peak = Math.max(peak, active);
				// Complete out of source order, with more than two full concurrency windows.
				await new Promise((resolve) => setTimeout(resolve, batch.id === 'b0001' ? 30 : 1));
				active--;
				effects.push('body-end');
				if (scenario === 'parallel-failure' && batch.id === 'b0002') throw new Error('Provider exhausted retries');
				return batch.segments.map((segment) => ({
					texts: Object.fromEntries(
						Object.keys(createMarkdownTranslationTemplate(segment).texts).map((key) => [
							key,
							parallel ? `譯文 ${segment.id}` : '這是一篇研究論文的可讀原始內容，需要完整翻譯。',
						]),
					),
				}));
			},
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
					if (scenario === 'app-unavailable') throw new Error('APP unavailable');
					return true;
				},
			]),
		);
		const workflow = new ResourceTranslationV2Workflow(
			{},
			{
				APP: app,
				AI: {
					run: async () => {
						metadataActive = true;
						effects.push('metadata-start');
						await new Promise((resolve) => setTimeout(resolve, 60));
						metadataActive = false;
						effects.push('metadata-end');
						return { response: JSON.stringify({ title: '研究論文' }) };
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
			assert.deepEqual(await result, { status: 'complete', resourceId });
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
				assert.deepEqual(providerBatches, [
					'b0001',
					'b0001-1',
					'b0001-2',
					'b0001-2-1',
					'b0001-2-1',
					'b0001-2-1',
					'b0001-2-2',
					'b0001-2-3',
					'b0001-2-4',
				]);
				assert.deepEqual(retryDelays, [60000, 120000], 'successful first half is not repeated when the second half retries');
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
