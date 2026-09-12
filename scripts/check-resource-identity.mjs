import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const workflowMocks = {
	'../shared/db': ['connectCoreDb'],
	'./platforms/web': ['stageWebAcquisition'],
	'./platforms/pdf': ['stageStoredPdfAcquisition'],
	'./platforms/paper': ['stagePaperResolution'],
	'./analysis': ['summarizeResource', 'classifyResource'],
	'./image-rehosting': ['stageResourceImages'],
	'./resource-persistence': ['persistResolvedResource', 'persistResourceClassification', 'loadPublicPdfContent', 'prepareResolvedResource'],
	'./zotero-sdt-service.ts': ['publishPublicPdfCrops'],
	'./resource-references': ['stageResourceReferences'],
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
		if (['/ingest/workflow.ts', '/ingest/acquisition.ts'].some((path) => context.parentURL?.endsWith(path)) && workflowMocks[specifier]) {
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

const { ResourceProcessingV2Workflow } = await import('../src/ingest/workflow.ts');
const { detectResourceLanguage } = await import('../src/ingest/resource-language.ts');
const { ResourceIdentifiersSchema, RESOURCE_KIND_METADATA, RESOURCE_PLATFORMS } = await import('../src/shared/resource.ts');
const { readFile } = await import('node:fs/promises');
// This is the cross-service invariant migration drift cannot check: Core's identity
// vocabulary must match the DB-only CHECK constraint.
const repair = await readFile(new URL('../../../web-tanstack/prisma/manual-indexes.sql', import.meta.url), 'utf8');
const constraint = repair.match(/ADD CONSTRAINT resources_identity_check\s+CHECK\s*\(([\s\S]*?)\n {2}\);/u)?.[1];
assert.ok(constraint);
assert.deepEqual(
	[...constraint.match(/kind IN \(([^)]+)\)/u)[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]),
	Object.keys(RESOURCE_KIND_METADATA),
);
assert.deepEqual(
	[...constraint.matchAll(/\('([^']+)',\s*'([^']+)'\)/gu)].map(([, kind, platform]) => [platform, kind]).sort(),
	Object.entries(RESOURCE_PLATFORMS)
		.map(([platform, { kind }]) => [platform, kind])
		.sort(),
);
assert.equal(ResourceIdentifiersSchema.safeParse([{ scheme: 'doi', value: '10.1000/example', preferred: true }]).success, true);
assert.equal(ResourceIdentifiersSchema.safeParse([{ scheme: 'doi', value: ' 10.1000/EXAMPLE ', preferred: true }]).success, false);
for (const [text, lang] of [
	['A preliminary evaluation found improved accuracy on two datasets.', 'en'],
	['這是一篇介紹人工智慧與機器學習的研究文章，探討模型如何理解語言並改善回答品質。', 'zh-Hant'],
	['这是一篇介绍人工智能与机器学习的研究文章，探讨模型如何理解语言并改善回答质量。', 'zh-Hans'],
	['Hello', 'und'],
])
	assert.equal(detectResourceLanguage(text), lang);

const resourceId = '30000000-0000-4000-8000-000000000001';
const rawId = '30000000-0000-4000-8000-000000000002';
const instanceId = 'contract-processing';
const revision = '0123456789abcdef0123456789abcdef';
const privateImage = `/api/media/asset/pdf-crops/${'a'.repeat(64)}/12-p3-1234567890abcdef.png`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error('Workflow contract attempted an external request');
};
const scenarios = [
	'published',
	'admission-rejected',
	'private-paper',
	'existing-public',
	'superseded-upload',
	'save-failed',
	'translation-failed',
	'classification-failed',
	'automatic-source',
];
try {
	for (const scenario of scenarios) {
		const owned = ['private-paper', 'existing-public', 'superseded-upload'].includes(scenario);
		const automatic = scenario === 'automatic-source';
		const effects = [];
		const persisted = [];
		const translations = [];
		const reports = [];
		const classificationGate = Promise.withResolvers();
		const classificationStarted = Promise.withResolvers();
		const resource = {
			kind: 'paper',
			resourcePlatform: null,
			resourceIdentifiers: [],
			fileType: 'application/pdf',
			url: 'https://example.com/paper.pdf',
			title: 'Research paper',
			source: 'Example',
			originalLang: automatic ? 'und' : 'en',
			summary: null,
			publishedDate: null,
			content: `An original research paper.\n\n![Figure](${privateImage})`,
			citations: { references: [{ key: 'r1', text: 'Cited paper.' }] },
			creators: [],
			subject: null,
		};
		const acquire = async () => {
			effects.push('acquired');
			return resource;
		};
		globalThis.resourceWorkflowContract = {
			connectCoreDb: async () => ({}),
			stageWebAcquisition: acquire,
			stageStoredPdfAcquisition: acquire,
			stagePaperResolution: (_env, _step, { resource: acquired }) => acquired,
			summarizeResource: async (value) => ({ originalLang: 'en', summary: value.summary || 'Summary' }),
			stageResourceImages: async () => [],
			prepareResolvedResource: (value) => {
				if (automatic)
					assert.deepEqual([value.originalLang, value.summary, value.publishedDate], ['en', 'Feed summary', '2026-09-11T00:00:00.000Z']);
				return value;
			},
			persistResolvedResource: async (_db, value, target) => {
				persisted.push({ value, target });
				const privateRendition = target.kind === 'existing' && target.ownedBlobId === rawId;
				effects.push(privateRendition ? 'private-persisted' : 'corpus-persisted');
				return {
					resourceId: privateRendition ? rawId : resourceId,
					scope: privateRendition ? 'private' : 'corpus',
					originalWritten: privateRendition || scenario !== 'existing-public',
					translationRevision: revision,
					acquisitionRevision: revision,
				};
			},
			loadPublicPdfContent: async () => 'Accepted canonical body.',
			publishPublicPdfCrops: async (_env, id, content) => {
				assert.equal(id, resourceId);
				assert.equal(content, 'Accepted canonical body.');
				effects.push('media-published');
			},
			classifyResource: async () => {
				assert.ok(effects.includes('ready') || automatic, 'Classification follows publication');
				if (scenario === 'published') {
					classificationStarted.resolve();
					await classificationGate.promise;
				}
				if (scenario === 'classification-failed') throw new Error('Classification unavailable');
				return { tags: ['Research'], keywords: [] };
			},
			persistResourceClassification: async () => effects.push('classified'),
			stageResourceReferences: async () => effects.push('references'),
			enqueueResourceTranslation: async (_env, id, _revision, forceRunKey) => {
				translations.push({ id, forceRunKey });
				if (scenario === 'translation-failed') throw new Error('Translation dispatch failed');
			},
		};
		const app = {
			verifyStoredBlobProcessing: async () => scenario !== 'superseded-upload',
			startResourceProgressTask: async () => scenario !== 'admission-rejected',
			reportResourceProgress: async (report) => {
				reports.push(report);
				if (report.status === 'complete') effects.push('ready');
			},
			completeResourceSave: async () => {
				if (scenario === 'save-failed') throw new Error('Save failed');
				effects.push('saved');
			},
			registerResourceProgressTask: async () => true,
			sealResourceProgressTask: async () => {},
		};
		const workflow = new ResourceProcessingV2Workflow(
			{},
			{
				APP: automatic ? new Proxy({}, { get: () => () => assert.fail('Automatic acquisition cannot depend on user progress') }) : app,
				RESOURCE_SEARCH_SYNC_QUEUE: { send: async () => effects.push('indexed') },
			},
		);
		const payload = owned
			? { kind: 'storedBlob', resourceId: rawId }
			: {
					kind: 'draft',
					url: resource.url,
					...(automatic
						? { progress: false, sourceHints: { originalLang: 'en', summary: ' Feed summary ', publishedDate: '2026-09-11T00:00:00.000Z' } }
						: { saveTarget: { kind: 'profileSave', userId: 'fixture' } }),
				};
		const run = workflow.run({ instanceId, payload }, { do: async (_name, ...args) => args.at(-1)({ attempt: 1 }) });
		if (scenario === 'published') {
			await classificationStarted.promise;
			assert.ok(effects.includes('ready') && translations.length === 1, 'Slow classification cannot delay reading or translation');
			classificationGate.resolve();
		}
		if (['save-failed', 'translation-failed'].includes(scenario)) await assert.rejects(run);
		else await run;
		if (['admission-rejected', 'superseded-upload'].includes(scenario)) {
			assert.deepEqual(effects, [], 'Rejected attempts cannot acquire or persist');
			continue;
		}
		if (scenario === 'save-failed') {
			assert.equal(reports.at(-1).status, 'failed');
			assert.ok(!effects.includes('ready') && !translations.length);
			continue;
		}
		assert.ok(effects.includes('corpus-persisted') && effects.includes('media-published'));
		if (!automatic) {
			assert.ok(effects.indexOf('media-published') < effects.indexOf('saved'));
			assert.ok(effects.indexOf('saved') < effects.indexOf('ready'));
			assert.equal(reports.at(-1).status, 'complete', 'Follow-up failure cannot undo publication');
		}
		assert.ok(effects.includes('indexed'), 'Published content remains searchable even if classification fails');
		assert.deepEqual(translations.map(({ id }) => id).sort(), (owned ? [rawId, resourceId] : [resourceId]).sort());
		if (owned) {
			assert.equal(persisted[0].target.ownedBlobId, rawId);
			assert.equal(persisted[0].value.kind, 'file');
			assert.match(persisted[0].value.content, /\/pdf-crops\//u);
			assert.equal(persisted[1].target.preservePublishedPdf, true);
			assert.doesNotMatch(persisted[1].value.content, /\/pdf-crops\//u);
		}
		if (scenario === 'existing-public')
			assert.equal(
				translations.find(({ id }) => id === resourceId).forceRunKey,
				undefined,
				'An unchanged public rendition shares its translation',
			);
	}
} finally {
	globalThis.fetch = originalFetch;
	delete globalThis.resourceWorkflowContract;
}
console.info(`Resource workflow contracts passed (${scenarios.length} scenarios).`);
