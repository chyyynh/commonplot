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
		if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: 'data:text/javascript,export class WorkflowEntrypoint {}' };
		if (specifier === 'cloudflare:workflows')
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/workers/core-worker/src/'))
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		return nextResolve(specifier, context);
	},
});
const { enqueueResourceTranslation } = await import('../src/ingest/translation-workflow.ts');
const queued = [];
const statuses = new Map();
let unavailable = false;
const env = {
	APP: { registerResourceProgressTask: async () => true },
	RESOURCE_TRANSLATION_V2_WORKFLOW: {
		get: async (id) => {
			if (unavailable || !statuses.has(id)) throw new Error('unavailable');
			return { status: async () => ({ status: statuses.get(id) }) };
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
const shared = await enqueueResourceTranslation(env, resourceId, revision, undefined, 'first-import');
unavailable = true;
assert.equal(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, 'second-import'),
	shared,
	'unavailable control plane must not duplicate a shared translation',
);
unavailable = false;
statuses.set(shared, 'errored');
const retry = await enqueueResourceTranslation(env, resourceId, revision, undefined, 'retry-import');
assert.notEqual(retry, shared, 'explicit processing retry must recover a failed unchanged translation');
assert.equal(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, 'retry-import'),
	retry,
	'durable enqueue retries use the same physical task',
);
assert.equal(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, 'later-retry-import'),
	retry,
	'concurrent imports must share the active retry generation',
);
statuses.set(retry, 'terminated');
assert.notEqual(
	await enqueueResourceTranslation(env, resourceId, revision, undefined, 'later-retry-import'),
	retry,
	'a failed retry generation can itself be recovered',
);
assert.equal(
	queued.every(({ params }) => params.force === undefined),
	true,
	'retry preserves existing human/complete fields through the normal translation plan',
);
console.info({ event: 'translation_retry_contract_passed', cases: 6 });
