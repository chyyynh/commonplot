import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

const workflowMocks = {
	'../shared/db': ['connectCoreDb'],
	'./acquisition': ['stageStoredResourceAcquisition', 'stageUrlAcquisition'],
	'./analysis': ['analyzeResource', 'classifyResource'],
	'./image-rehosting': ['stageResourceImages'],
	'./resource-persistence': [
		'persistResolvedResource',
		'persistResourceClassification',
		'publishPublicPdfCrops',
		'prepareResolvedResource',
	],
	'./resource-references': ['enqueueResourceReferenceEnrichment'],
	'./translation-workflow': ['enqueueResourceTranslation'],
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'cloudflare:workers') {
			return {
				shortCircuit: true,
				url: 'data:text/javascript,export class WorkflowEntrypoint { constructor(_ctx,env) { this.env = env; } }',
			};
		}
		if (context.parentURL?.endsWith('/ingest/workflow.ts') && workflowMocks[specifier]) {
			const source = workflowMocks[specifier]
				.map((name) => `export const ${name} = (...args) => globalThis.resourceWorkflowContract[${JSON.stringify(name)}](...args);`)
				.join('\n');
			return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
		}
		if (specifier === 'cloudflare:workflows') {
			return { shortCircuit: true, url: 'data:text/javascript,export class NonRetryableError extends Error {}' };
		}
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/workers/core-worker/src/')) {
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		}
		return nextResolve(specifier, context);
	},
});

const [resource, paper, { resolvePlatformResourceUrl }, { analyzeResource, classifyResource }] = await Promise.all([
	import('../src/shared/resource.ts'),
	import('../src/shared/paper-identity.ts'),
	import('../src/ingest/acquisition.ts'),
	import('../src/ingest/analysis.ts'),
]);

const platformUrlCases = [
	['https://twitter.com/openai/status/1234567890?s=20', ['twitter', '1234567890', 'https://x.com/i/status/1234567890']],
	[
		'https://news.ycombinator.com/item?id=12345678&utm_source=feed',
		['hackernews', '12345678', 'https://news.ycombinator.com/item?id=12345678'],
	],
	['https://youtu.be/dQw4w9WgXcQ?t=43', ['youtube', 'dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ']],
	[
		'https://www.lesswrong.com/posts/A2kJKqnHhh5Hq4p2S/example-slug',
		['lesswrong', 'A2kJKqnHhh5Hq4p2S', 'https://lesswrong.com/posts/A2kJKqnHhh5Hq4p2S'],
	],
	['https://example.com/article', null],
	['https://example.com/openai/status/1234567890', null],
	['https://news.ycombinator.com/item?id=0', null],
	['https://x.com/openai/status/not-a-tweet', null],
	['https://x.com/openai/status/123abc', null],
	['https://youtu.be/too-short', null],
	['https://lesswrong.com/posts/short', null],
];
for (const [input, expected] of platformUrlCases) {
	const actual = resolvePlatformResourceUrl(new URL(input));
	assert.deepEqual(actual ? [actual.resourcePlatform, actual.platformId, actual.canonicalUrl] : null, expected, input);
}

const canonicalIdentifiers = [
	{ preferred: true, scheme: 'doi', value: '10.1000/example' },
	{ preferred: true, scheme: 'youtube', value: 'dQw4w9WgXcQ' },
];
assert.deepEqual(resource.ResourceIdentifiersSchema.parse(canonicalIdentifiers), canonicalIdentifiers);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'doi', value: ' 10.1000/EXAMPLE ' }]).success, false);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: false, scheme: 'twitter', value: '123' }]).success, false);
assert.equal(
	resource.ResourceIdentifiersSchema.safeParse([
		{ preferred: true, scheme: 'arxiv', value: '2401.12345' },
		{ preferred: true, scheme: 'arxiv', value: '2402.12345' },
	]).success,
	false,
);

for (const input of [
	'https://arxiv.org/abs/2507.12652',
	'https://arxiv.org/html/2507.12652v2',
	'https://arxiv.org/pdf/2507.12652v3.pdf',
	'arXiv:2507.12652v4',
	'2507.12652',
]) {
	assert.deepEqual(paper.resolveExactPaperInput(input), {
		canonicalUrl: 'https://arxiv.org/abs/2507.12652',
		identity: { arxivId: '2507.12652' },
	});
}
assert.deepEqual(paper.resolveExactPaperInput('https://openalex.org/w2741809807'), {
	canonicalUrl: 'https://openalex.org/W2741809807',
	identity: { openAlexId: 'W2741809807' },
});
assert.deepEqual(paper.paperIdentityFromText('DOI: 10.1000/EXAMPLE\narXiv:2401.00001v2'), {
	doi: '10.1000/example',
	arxivId: '2401.00001',
});
assert.deepEqual(paper.paperIdentityFromText('arXiv preprint arXiv 2401.00001v2'), {
	arxivId: '2401.00001',
});
assert.deepEqual(
	paper.paperIdentifiersFromIdentity({
		doi: 'DOI: 10.1000/EXAMPLE',
		arxivId: 'arXiv:2401.00001v2',
		openAlexId: 'https://openalex.org/w2741809807',
	}),
	[
		{ preferred: true, scheme: 'doi', value: '10.1000/example' },
		{ preferred: true, scheme: 'arxiv', value: '2401.00001' },
		{ preferred: true, scheme: 'openalex', value: 'W2741809807' },
	],
);
assert.deepEqual(
	paper.normalizePaperIdentifiers([
		{ scheme: 'arxiv', value: 'arXiv:2405.06478', preferred: true },
		{ scheme: 'openalex', value: 'W4411722349', preferred: true },
		{ scheme: 'openalex', value: 'w4396882289', preferred: true },
		{ scheme: 'doi', value: 'https://doi.org/10.1007/S00146-025-02400-Z' },
	]),
	[
		{ scheme: 'arxiv', value: '2405.06478', preferred: true },
		{ scheme: 'openalex', value: 'W4411722349', preferred: true },
		{ scheme: 'openalex', value: 'W4396882289', preferred: false },
		{ scheme: 'doi', value: '10.1007/s00146-025-02400-z', preferred: true },
	],
);
assert.equal(resource.ResourceIdentifiersSchema.safeParse([{ preferred: true, scheme: 'youtube', value: 'too-short' }]).success, false);

const { detectResourceLanguage } = await import('../src/ingest/resource-language.ts');
const languageCases = [
	['A preliminary evaluation found improved accuracy on two datasets.', 'en'],
	['這是一篇介紹人工智慧與機器學習的研究文章，探討模型如何理解語言並改善回答品質。', 'zh-Hant'],
	['这是一篇介绍人工智能与机器学习的研究文章，探讨模型如何理解语言并改善回答质量。', 'zh-Hans'],
	['この研究では人工知能の新しいモデルを評価し、回答の品質と処理速度を比較しています。', 'ja'],
	['今天介紹 OpenAI 的 GPT 模型，透過 API 提升開發效率，也能協助研究人員整理資料。', 'zh-Hant'],
	['Researchers compared GPT and Claude on several tasks. A short Chinese quote follows: 你好。 The results remain preliminary.', 'en'],
	['Cette recherche compare les performances de plusieurs modèles et analyse les limites de leurs résultats.', 'fr'],
	['Diese Untersuchung vergleicht verschiedene Sprachmodelle und beschreibt die Grenzen der Ergebnisse.', 'de'],
	['Hello', 'und'],
	['', 'und'],
	['12345', 'und'],
	['```js\nconst example = "this is English code";\n```', 'und'],
];
for (const [text, expected] of languageCases) assert.equal(detectResourceLanguage(text), expected, text);
assert.equal(detectResourceLanguage('短文', 'zh-Hant'), 'zh-Hant');
assert.equal(detectResourceLanguage(languageCases[1][0], 'zh'), 'zh-Hant');
assert.equal(detectResourceLanguage(languageCases[2][0], 'zh'), 'zh-Hans');

const generatedSummary = 'A preliminary evaluation found improved accuracy on two datasets.';
for (const [summary, originalLang, expectedLang] of [
	['Existing source abstract, including its limitations.', 'en', 'en'],
	[null, 'und', 'en'],
	['', 'zh-Hant', 'zh-Hant'],
	['   ', 'und', 'en'],
]) {
	const input = { title: 'Evaluation', source: 'Example', kind: 'blog', content: generatedSummary, summary, originalLang };
	let calls = 0;
	const output = { summary: generatedSummary };
	const env = {
		AI: {
			run: async (model, request, options) => {
				calls++;
				assert.equal(model, 'google/gemini-3.5-flash-lite');
				assert.equal(options.gateway.id, 'core-ingest');
				assert.equal(options.extraHeaders['cf-aig-collect-log-payload'], 'false');
				assert.deepEqual(Object.keys(request.response_format.json_schema.schema.properties), ['summary']);
				assert.equal(request.chat_template_kwargs, undefined);
				assert.equal(options.returnRawResponse, true);
				return Response.json({
					choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
				});
			},
		},
		AI_GATEWAY_ENVIRONMENT: 'development',
	};
	const analysis = await analyzeResource(input, ['source-keyword'], env, 'analysis-contract');
	assert.equal(analysis.summary, summary?.trim() || generatedSummary);
	assert.equal(analysis.originalLang, expectedLang);
	assert.deepEqual(analysis.tags, []);
	assert.deepEqual(analysis.keywords, ['source-keyword']);
	assert.equal(calls, summary?.trim() ? 0 : 1, 'source summary must avoid the publication-time AI request');
	if (!summary?.trim()) {
		output.summary = '   ';
		await assert.rejects(analyzeResource(input, [], env, 'analysis-contract'));
	}
}
const classificationOutput = { tags: ['Research'], keywords: ['evaluation'] };
const classificationEnv = {
	AI: {
		run: async (model, request, options) => {
			assert.equal(model, 'google/gemini-3.5-flash-lite');
			assert.equal(options.gateway.id, 'core-ingest');
			assert.deepEqual(Object.keys(request.response_format.json_schema.schema.properties), ['tags', 'keywords']);
			return Response.json({
				choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(classificationOutput) }, finish_reason: 'stop' }],
			});
		},
	},
	AI_GATEWAY_ENVIRONMENT: 'development',
};
const classificationInput = { title: 'Evaluation', source: 'Example', kind: 'blog', content: generatedSummary, originalLang: 'en' };
assert.deepEqual(await classifyResource(classificationInput, classificationEnv, 'classification-contract'), classificationOutput);
classificationOutput.tags = Array.from({ length: 6 }, () => 'Research');
await assert.rejects(classifyResource(classificationInput, classificationEnv, 'classification-contract'));
classificationOutput.tags = ['Research'];
classificationOutput.keywords = Array.from({ length: 9 }, () => 'evaluation');
await assert.rejects(classifyResource(classificationInput, classificationEnv, 'classification-contract'));

console.info({
	event: 'resource_contract_smoke_passed',
	identifierContractCases: 5,
	urlCases: platformUrlCases.length,
});

// Run the real main Workflow against controlled provider/persistence boundaries.
// The fake durable step executes callbacks once; native retry timing is outside
// this Node test.
const { ResourceProcessingV2Workflow } = await import('../src/ingest/workflow.ts');
const workflowResourceId = '30000000-0000-4000-8000-000000000001';
const workflowRawId = '30000000-0000-4000-8000-000000000002';
const workflowInstanceId = 'app-ingest-v1-30000000-0000-4000-8000-000000000003';
const acquisitionRevision = '0123456789abcdef0123456789abcdef';
const subjectTarget = {
	kind: 'draft',
	relation: { kind: 'subject', parentResourceId: workflowResourceId, parentAcquisitionRevision: acquisitionRevision },
	url: 'https://example.com/subject',
	sourceHints: { publishedDate: '2026-09-11T00:00:00.000Z' },
};
// This existing ID is an execution/idempotency contract: progress policy must
// not change the serialized target hashed by already-admitted user children.
const subjectHash = createHash('sha256').update(JSON.stringify(subjectTarget)).digest('hex');
const sourcePayload = {
	kind: 'draft',
	relation: { kind: 'source', sourceId: '30000000-0000-4000-8000-000000000004' },
	url: 'https://example.com/paper.pdf',
};
const workflowCases = [
	{ name: 'classification-delayed' },
	{ name: 'classification-failed' },
	...[
		'published-pdf',
		'private-pdf-resolved',
		'private-pdf-existing-public',
		'crops-failed',
		'analysis-failed',
		'ready-delivery-failed',
		'background-handoff-failed',
		'translation-handoff-failed',
		'superseded-raw',
		'expired-admission',
	].map((name) => ({ name })),
	{ name: 'automatic-source', payload: sourcePayload, instanceId: 'source-contract-first', appUnavailable: true, subject: true },
	{ name: 'automatic-source-repeat', payload: sourcePayload, instanceId: 'source-contract-repeat', appUnavailable: true, subject: true },
	{
		name: 'automatic-reacquire',
		payload: { kind: 'reacquire', resourceId: workflowResourceId },
		instanceId: 'reacquire-contract',
		appUnavailable: true,
		subject: true,
	},
	{
		name: 'managed-progress-opt-out',
		payload: { kind: 'draft', url: 'https://example.com/paper.pdf', progress: false },
		rejectStart: true,
	},
	{ name: 'legacy-subject', payload: subjectTarget, instanceId: `subject-draft-v4-${subjectHash}`, rejectStart: true },
	{
		name: 'automatic-subject',
		payload: { ...subjectTarget, progress: false },
		instanceId: `subject-draft-auto-v1-${subjectHash}`,
		appUnavailable: true,
	},
	{ name: 'user-subject', subject: true },
];
const subjectIds = new Map();
const providerFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error('Workflow contract attempted an external provider request');
};
try {
	for (const {
		name: scenario,
		payload: inputPayload,
		instanceId = workflowInstanceId,
		appUnavailable = false,
		subject = false,
		rejectStart = false,
	} of workflowCases) {
		const effects = [];
		const reports = [];
		const warnings = [];
		const appCalls = [];
		const registrations = [];
		const searchMessages = [];
		const translations = [];
		const references = [];
		const children = [];
		let releaseClassification;
		const classificationGate = new Promise((resolve) => {
			releaseClassification = resolve;
		});
		let rejectReady = scenario === 'ready-delivery-failed';
		const acquired = {
			kind: subject ? 'blog' : 'paper',
			url: 'https://example.com/paper.pdf',
			resourcePlatform: null,
			fileType: subject ? 'text/html' : 'application/pdf',
			originalLang: 'en',
			content: 'An original research paper with readable content.',
			resourceImages: [],
			resourceIdentifiers: [],
			subject: subject ? { normalizedUrl: subjectTarget.url, publishedDate: subjectTarget.sourceHints.publishedDate } : null,
		};
		const acquire = () => {
			effects.push('acquired');
			return acquired;
		};
		globalThis.resourceWorkflowContract = {
			connectCoreDb: async () => ({
				execute: async () => ({
					rows: [{ original_lang: 'en', published_date: null, resource_identifiers: [], summary: null, url: acquired.url }],
				}),
			}),
			stageStoredResourceAcquisition: acquire,
			stageUrlAcquisition: (_env, _step, input) => {
				if (scenario === 'automatic-reacquire') {
					assert.deepEqual(input.hints, { originalLang: null, publishedDate: null, summary: null });
					assert.equal(input.paperIdentifiers, undefined);
				}
				return acquire();
			},
			analyzeResource: async () => {
				if (scenario === 'analysis-failed') throw new Error('Analysis unavailable');
				return { tags: [], keywords: [], originalLang: 'en', summary: 'Fixture summary' };
			},
			classifyResource: async () => {
				if (!appUnavailable) assert.ok(effects.includes('ready'), 'classification starts after publication');
				if (scenario === 'classification-delayed') await classificationGate;
				if (scenario === 'classification-failed') throw new Error('Classification unavailable');
				effects.push('classified');
				return { tags: ['Research'], keywords: ['evaluation'] };
			},
			persistResourceClassification: async (_db, target) => {
				assert.equal(target.acquisitionRevision, acquisitionRevision);
				if (scenario === 'private-pdf-existing-public') assert.equal(target.resourceId, workflowRawId);
				effects.push('classification-persisted');
				return true;
			},
			stageResourceImages: async (_env, _step, _processingId, _sources, refreshKey) => {
				assert.equal(refreshKey, scenario === 'automatic-reacquire' ? instanceId : undefined);
				return [];
			},
			prepareResolvedResource: (value) => value,
			persistResolvedResource: async (_db, _resource, target) => {
				const privateRendition = target.kind === 'existing' && target.ownedBlobId === workflowRawId;
				effects.push(privateRendition ? 'private-persisted' : 'corpus-persisted');
				return {
					resourceId: privateRendition ? workflowRawId : workflowResourceId,
					scope: privateRendition ? 'private' : 'corpus',
					originalWritten: privateRendition || scenario !== 'private-pdf-existing-public',
					translationRevision: 'fixture-revision',
					acquisitionRevision,
				};
			},
			publishPublicPdfCrops: async () => {
				if (scenario === 'crops-failed') throw new Error('Crop publication unavailable');
				effects.push('public-crops');
			},
			enqueueResourceReferenceEnrichment: async (...args) => {
				references.push(args.at(-1));
				effects.push('references-enqueued');
			},
			enqueueResourceTranslation: async (...args) => {
				if (scenario === 'translation-handoff-failed') throw new Error('Translation dispatch unavailable');
				translations.push(args.at(-1));
				effects.push('translation-enqueued');
			},
		};
		const app = {
			verifyStoredBlobProcessing: async () => scenario !== 'superseded-raw',
			startResourceProgressTask: async () => scenario !== 'expired-admission' && !rejectStart,
			reportResourceProgress: async (report) => {
				reports.push(report);
				if (report.status === 'complete') {
					if (rejectReady) {
						rejectReady = false;
						throw new Error('Progress delivery unavailable after publication');
					}
					effects.push('ready');
				}
			},
			completeResourceSave: async () => effects.push('profile-attached'),
			registerResourceProgressTask: async (input) => {
				registrations.push(input);
				return true;
			},
			sealResourceProgressTask: async (_taskId, errorCode) => warnings.push(errorCode),
		};
		const workflow = new ResourceProcessingV2Workflow(
			{},
			{
				APP: new Proxy(app, {
					get(target, method) {
						return async (...args) => {
							appCalls.push(method);
							if (appUnavailable) throw new Error('App unavailable');
							return target[method](...args);
						};
					},
				}),
				RESOURCE_PROCESSING_V2_WORKFLOW: {
					createBatch: async (instances) => {
						children.push(...instances);
						return instances.map(({ id }) => ({ id }));
					},
				},
				RESOURCE_SEARCH_SYNC_QUEUE: {
					send: async (message) => {
						if (scenario === 'background-handoff-failed') throw new Error('Search queue unavailable');
						searchMessages.push(message);
						effects.push('search-enqueued');
					},
				},
			},
		);
		const owned = ['private-pdf-resolved', 'private-pdf-existing-public', 'superseded-raw'].includes(scenario);
		const payload =
			inputPayload ??
			(owned
				? { kind: 'storedBlob', resourceId: workflowRawId }
				: { kind: 'draft', url: 'https://example.com/paper.pdf', saveTarget: { kind: 'profileSave', userId: 'fixture-user' } });
		const step = { do: async (_name, ...args) => args.at(-1)({ attempt: 1 }) };
		const result = workflow.run({ instanceId, payload }, step);
		if (scenario === 'classification-delayed') {
			await new Promise((resolve) => setImmediate(resolve));
			assert.ok(
				effects.includes('ready') && effects.includes('translation-enqueued'),
				'slow classification must not block reading or translation',
			);
			assert.ok(!effects.includes('search-enqueued'), 'search waits for classification');
			releaseClassification();
		}
		if (scenario.endsWith('-failed') && !['background-handoff-failed', 'classification-failed'].includes(scenario))
			await assert.rejects(result, undefined, scenario);
		else await result;
		if (scenario === 'superseded-raw' || scenario === 'expired-admission' || rejectStart) {
			assert.deepEqual(effects, [], `${scenario}: rejected attempts must not run providers or persist`);
			assert.equal(
				reports.some((report) => report.status === 'complete'),
				false,
				scenario,
			);
			if (rejectStart) {
				assert.deepEqual(appCalls, ['startResourceProgressTask'], `${scenario}: the durable admission gate remains mandatory`);
			}
			continue;
		}
		if (subject) {
			const childId = `${appUnavailable ? 'subject-draft-auto-v1' : 'subject-draft-v4'}-${subjectHash}`;
			assert.deepEqual(children, [{ id: childId, params: { ...subjectTarget, progress: !appUnavailable } }], scenario);
			subjectIds.set(scenario, childId);
			if (!appUnavailable) {
				assert.ok(effects.includes('profile-attached'), `${scenario}: user save still completes`);
				assert.deepEqual(
					registrations.find(({ taskId }) => taskId === childId),
					{ taskId: childId, kind: 'processing', parentTaskId: instanceId },
					`${scenario}: child progress belongs to the initiating import`,
				);
			}
		}
		if (appUnavailable) {
			assert.deepEqual(appCalls, [], `${scenario}: automatic work must not depend on any app method`);
			assert.ok(effects.includes('acquired') && effects.includes('corpus-persisted'), `${scenario}: acquisition and persistence finish`);
			assert.deepEqual(searchMessages, [{ resourceId: workflowResourceId }], `${scenario}: search delivery has no user task ledger`);
			assert.equal(translations.length, 1, `${scenario}: translation still enqueues`);
			assert.equal(translations[0].taskId, instanceId, scenario);
			assert.equal(translations[0].required, false, `${scenario}: follow-up inherits automatic execution policy`);
			continue;
		}
		if (subject) {
			assert.equal(reports.at(-1).status, 'complete', scenario);
			assert.equal(translations[0].required, true, `${scenario}: follow-up inherits the managed task policy`);
			continue;
		}
		if (scenario === 'analysis-failed' || scenario === 'crops-failed') {
			assert.equal(reports.at(-1).status, 'failed', scenario);
			assert.equal(reports.at(-1).stage, undefined, `${scenario}: failure must retain the last reported stage`);
			assert.equal(
				reports.filter((report) => report.status === 'running').at(-1).stage,
				scenario === 'analysis-failed' ? 'analyzing' : 'persisting',
				scenario,
			);
			assert.equal(effects.includes('profile-attached'), false, scenario);
			assert.equal(effects.includes('ready'), false, scenario);
			continue;
		}
		assert.ok(effects.includes('public-crops'), `${scenario}: public PDF images are published`);
		assert.ok(effects.includes('profile-attached'), `${scenario}: resource reaches its owner`);
		assert.ok(effects.indexOf('public-crops') < effects.indexOf('profile-attached'), `${scenario}: crops precede profile publication`);
		assert.ok(effects.indexOf('profile-attached') < effects.indexOf('ready'), `${scenario}: ready includes the owner attachment`);
		assert.equal(reports.at(-1).status, 'complete', scenario);
		assert.equal(reports.at(-1).resourceId, workflowResourceId, scenario);
		assert.equal(
			reports.some((report) => report.status === 'failed'),
			false,
			`${scenario}: follow-ups cannot undo publication`,
		);
		if (scenario === 'classification-failed') {
			assert.ok(effects.includes('translation-enqueued') && effects.includes('search-enqueued'));
			assert.ok(!effects.includes('classification-persisted'));
		}
		if (effects.includes('classification-persisted') && effects.includes('search-enqueued')) {
			assert.ok(effects.indexOf('classification-persisted') < effects.indexOf('search-enqueued'));
		}
		if (scenario === 'private-pdf-resolved') {
			assert.ok(effects.includes('private-persisted'));
			assert.ok(effects.indexOf('private-persisted') < effects.indexOf('corpus-persisted'));
			assert.ok(effects.indexOf('profile-attached') < effects.indexOf('references-enqueued'));
			assert.equal(references[0].taskId, instanceId);
			assert.equal(references[0].required, true);
			assert.equal(translations.length, 2, 'Both private and canonical translations are admitted');
			assert.ok(translations.every((parent) => parent.taskId === instanceId && parent.required === true));
		}
		if (scenario === 'background-handoff-failed')
			assert.ok(effects.includes('translation-enqueued'), 'Independent handoffs still run after a failure');
		if (scenario === 'background-handoff-failed')
			assert.ok(
				warnings.every((warning) => warning === undefined),
				'Background dispatch cannot mark readable content as pending',
			);
		if (scenario === 'ready-delivery-failed' || scenario === 'translation-handoff-failed') {
			assert.ok(warnings.includes('followup_dispatch_failed'), scenario);
		}
	}
	assert.equal(subjectIds.get('automatic-source'), subjectIds.get('automatic-source-repeat'), 'Automatic parent reruns reuse one child ID');
	assert.equal(subjectIds.get('automatic-source'), subjectIds.get('automatic-reacquire'), 'The same automatic subject target keeps its ID');
	assert.notEqual(
		subjectIds.get('automatic-source'),
		subjectIds.get('user-subject'),
		'User and automatic subjects have separate executions',
	);
} finally {
	globalThis.fetch = providerFetch;
	delete globalThis.resourceWorkflowContract;
}
console.info({ event: 'resource_workflow_contract_passed', cases: workflowCases.length });
