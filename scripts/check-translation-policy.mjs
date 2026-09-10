import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
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
			const name = specifier === '../shared/db' ? 'connectCoreDb' : 'translateMarkdownBatchToZhHant';
			return {
				shortCircuit: true,
				url: `data:text/javascript,${encodeURIComponent(`export const ${name} = (...args) => globalThis.translationWorkflowContract.${name}(...args);`)}`,
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
const reports = [];
const sealed = [];
const parent = (taskId, required = true) => ({ taskId, required });
const statuses = new Map();
let unavailable = false;
const env = {
	APP: {
		registerResourceProgressTask: async (input) => {
			registered.push(input);
			return true;
		},
		reportResourceProgress: async (input) => {
			reports.push(input);
			return true;
		},
		sealResourceProgressTask: async (id) => {
			sealed.push(id);
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

const { readResourceTaskStatus, reportResourceTask } = await import('../src/ingest/progress.ts');
const automaticRevision = 'b'.repeat(32);
const registrationsBeforeAutomatic = registered.length;
const automatic = await enqueueResourceTranslation(env, resourceId, automaticRevision, undefined, parent('source-draft', false));
assert.equal(registered.length, registrationsBeforeAutomatic, 'automatic producers do not depend on Web task registration');
assert.equal(queued.at(-1).params.progress, false);
assert.equal(await enqueueResourceTranslation(env, resourceId, automaticRevision, undefined, parent('late-user')), automatic);
assert.equal(registered.at(-1).reconcile, true, 'a user adopting automatic translation can recover lost optional delivery');
assert.equal(
	queued.find(({ id }) => id === automatic).params.progress,
	false,
	'late subscription preserves the original automatic execution payload',
);
for (const status of ['complete', 'skipped', 'superseded']) {
	statuses.set(automatic, { status: 'complete', output: { status, resourceId } });
	const creationCount = queued.length;
	assert.equal(await enqueueResourceTranslation(env, resourceId, automaticRevision, undefined, parent(`late-${status}`)), automatic);
	assert.equal(queued.length, creationCount, 'a retained terminal snapshot does not rerun a provider');
	assert.equal(reports.at(-1).status, status, 'captured native domain outcome is delivered before native retention can expire');
	assert.equal(sealed.at(-1), automatic);
	assert.deepEqual(await readResourceTaskStatus(env, { taskId: automatic, kind: 'translation' }), { status, resourceId });
}
statuses.set(automatic, { status: 'complete' });
const registrationsBeforeLegacy = registered.length;
await enqueueResourceTranslation(env, resourceId, automaticRevision, undefined, parent('late-legacy'));
assert.equal(registered.length, registrationsBeforeLegacy, 'already completed legacy execution has no new queued work');
assert.deepEqual(await readResourceTaskStatus(env, { taskId: automatic, kind: 'translation' }), {
	status: 'complete',
	errorCode: 'native_outcome_unavailable',
});
for (const [status, expected] of [
	['queued', { status: 'queued' }],
	['paused', { status: 'running' }],
	['unknown', null],
	['errored', { status: 'failed', errorCode: 'native_workflow_failed' }],
	['terminated', { status: 'failed', errorCode: 'native_workflow_terminated' }],
]) {
	statuses.set(automatic, status);
	assert.deepEqual(await readResourceTaskStatus(env, { taskId: automatic, kind: 'translation' }), expected);
}
unavailable = true;
await assert.rejects(readResourceTaskStatus(env, { taskId: automatic, kind: 'translation' }), /unavailable/);
unavailable = false;
const boundedDelivery = reportResourceTask(
	{ APP: { reportResourceProgress: () => new Promise(() => {}) } },
	{ taskId: automatic, status: 'running' },
	false,
);
let deadline;
try {
	await Promise.race([
		boundedDelivery,
		new Promise((_resolve, reject) => {
			deadline = setTimeout(() => reject(new Error('Optional delivery did not finish within its bound')), 2500);
		}),
	]);
} finally {
	clearTimeout(deadline);
}
console.info({ event: 'shared_translation_recovery_contract_passed' });

// Execute the actual translation Workflow with provider/DB boundaries controlled.
const { createMarkdownTranslationTemplate } = await import('../src/ingest/markdown-translation.ts');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error('Translation contract attempted an external provider request');
};
try {
	for (const scenario of ['optional-app-unavailable', 'optional-index-unavailable', 'legacy-required-app-unavailable']) {
		const effects = [];
		const appCalls = [];
		let reads = 0;
		globalThis.translationWorkflowContract = {
			connectCoreDb: async () => ({
				execute: async () => {
					reads++;
					if (reads > 1) {
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
								content: 'This is the original readable content of a research paper that requires translation.',
								zh_hant_title: '研究論文',
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
				return batch.segments.map((segment) => ({
					texts: Object.fromEntries(
						Object.keys(createMarkdownTranslationTemplate(segment).texts).map((key) => [
							key,
							'這是一篇研究論文的可讀原始內容，需要完整翻譯。',
						]),
					),
				}));
			},
		};
		const app = Object.fromEntries(
			['startResourceProgressTask', 'reportResourceProgress', 'registerResourceProgressTask', 'sealResourceProgressTask'].map((name) => [
				name,
				async () => {
					appCalls.push(name);
					throw new Error('APP unavailable');
				},
			]),
		);
		const workflow = new ResourceTranslationV2Workflow(
			{},
			{
				APP: app,
				RESOURCE_SEARCH_SYNC_QUEUE: {
					send: async (body) => {
						assert.deepEqual(body, { resourceId }, 'automatic indexing carries no untracked task ID');
						if (scenario === 'optional-index-unavailable') throw new Error('Queue unavailable');
						effects.push('indexed');
					},
				},
			},
		);
		const result = workflow.run(
			{
				instanceId: 'shared-translation-contract',
				payload: { resourceId, translationRevision: revision, ...(scenario.startsWith('optional') ? { progress: false } : {}) },
			},
			{ do: async (_name, ...args) => args.at(-1)({ attempt: 1 }) },
		);
		if (scenario.startsWith('optional')) {
			assert.deepEqual(await result, {
				status: 'complete',
				resourceId,
				...(scenario === 'optional-index-unavailable' ? { errorCode: 'followup_dispatch_failed' } : {}),
			});
			assert.ok(effects.includes('provider') && effects.includes('persisted'));
			assert.equal(appCalls.includes('startResourceProgressTask'), false, 'optional translation does not acquire a required user gate');
			assert.equal(appCalls.includes('registerResourceProgressTask'), false, 'optional descendants do not create stranded task ledgers');
			assert.ok(appCalls.includes('reportResourceProgress') && appCalls.includes('sealResourceProgressTask'));
		} else {
			await assert.rejects(result, /APP unavailable/);
			assert.deepEqual(effects, [], 'legacy child payloads remain gated before paid provider execution');
		}
	}
} finally {
	globalThis.fetch = originalFetch;
	delete globalThis.translationWorkflowContract;
}
console.info({ event: 'translation_workflow_outage_contract_passed', cases: 3 });

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
  const task=createResourceTask(taskEnv,step,event.instanceId,event.payload.delivery);
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
 if(request.method==='POST'){await env.TASK.create({id:path,params:{delivery:path}});return Response.json({id:path});}
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
	for (const delivery of ['none', 'optional']) {
		const response = await runtime.fetch(`/${delivery}`, { method: 'POST' });
		assert.equal(response.status, 200, await response.clone().text());
		const deadline = Date.now() + 25_000;
		let snapshot;
		do {
			snapshot = await (await runtime.fetch(`/${delivery}`)).json();
			if (['complete', 'errored'].includes(snapshot.status)) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		} while (Date.now() < deadline);
		assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot));
		assert.deepEqual(snapshot.output, { status: 'complete', resourceId });
	}
	console.info({ event: 'resource_task_native_workflow_outage_passed', cases: 2 });
} finally {
	await runtime?.stop();
	await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
