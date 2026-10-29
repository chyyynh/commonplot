// A Resource's translation into zh-Hant, plus an English title for recommendation vectors: admission (imports, reader
// requests, the derivation sweep) and the durable Workflow that loads, translates and stores it. The translating itself is
// services/translation, which knows nothing of Resources.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { RESOURCE_KINDS } from '../contracts/resource-kinds';
import { isWrittenInOriginal } from '../contracts/resource-language';
import { coreExports } from '../exports.ts';
import { AI_STEP_RETRIES } from '../services/ai-model';
import { errorMessage } from '../services/response';
import { failureReason, translateMarkdown, translateTitle } from '../services/translation';
import { STORAGE_STEP, stepJson } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import {
	isTranslatable,
	loadResourceTranslationInput,
	loadTranslationCandidate,
	loadTranslationStates,
	TextHashSchema,
	persistMachineTranslation,
	type ResourceTranslationCandidate,
	type ResourceTranslationInput,
	settleOpenTranslations,
} from '../store/derivations';

/** `metadata` translates the title; `full` also translates the content. */
type TranslationScope = 'metadata' | 'full';
type ResourceTranslationPayload = { force?: boolean; resourceId: string; textHash: string; scope: TranslationScope };

// Admission

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v36';

// One execution per original and scope: concurrent imports, requests and the sweep all meet on this ID, so paid work
// is never doubled, and a changed original gets a new one. Its translation rows, not the execution, say whether it landed.
function translationInstanceId(resourceId: string, textHash: string, scope: TranslationScope): string {
	return `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${scope}-${resourceId}-${textHash}`;
}

async function translationExecution(id: string) {
	let snapshot: Awaited<ReturnType<WorkflowInstance['status']>>;
	try {
		snapshot = await (await coreExports.ResourceTranslationV2Workflow.get(id)).status();
	} catch {
		// Missing, expired, or an unavailable control plane: createBatch recovers this exact ID either way.
		return 'absent' as const;
	}
	if (snapshot.status === 'errored' || snapshot.status === 'terminated') return 'rerun' as const;
	return snapshot.status === 'complete' ? ('done' as const) : ('live' as const);
}

/** What an import shows for its translations: running while any is open or a full one is live, failed once one failed. */
export async function importTranslationProgress(
	db: NodePgDatabase,
	resourceId: string,
	textHash: string,
): Promise<'running' | 'failed' | undefined> {
	const [states, full] = await Promise.all([
		loadTranslationStates(db, resourceId, textHash),
		translationExecution(translationInstanceId(resourceId, textHash, 'full')),
	]);
	if (states.includes('pending') || full === 'live') return 'running';
	if (states.includes('failed') || full === 'rerun') return 'failed';
	return undefined;
}

// `execution` is what the same work was before this call: live and done ones are left alone.
export async function enqueueResourceTranslation(
	resource: ResourceTranslationCandidate & Readonly<{ id: string; textHash: string }>,
	scope: TranslationScope,
	force: boolean,
) {
	if (!isTranslatable(resource)) return null;
	const { id: resourceId, textHash } = resource;
	TextHashSchema.parse(textHash);
	const id = translationInstanceId(resourceId, textHash, scope);
	const execution = await translationExecution(id);
	// Completed work already lives in ResourceTranslation. There is no new
	// execution to subscribe to, and no second source of progress to project.
	if (execution === 'done') return { id, execution };
	// Concurrent callers share one execution; a failed one runs again under the same ID.
	if (execution === 'rerun') await (await coreExports.ResourceTranslationV2Workflow.get(id)).restart();
	if (execution === 'absent') {
		await coreExports.ResourceTranslationV2Workflow.createBatch([
			{ id, params: { ...(force ? { force: true } : {}), resourceId, textHash, scope } },
		]);
	}
	return { id, execution };
}

/** A reader's request for a stored Resource's full translation; the app Worker admits and bills it first. */
export async function requestContentTranslation(env: CoreEnv, resourceId: string) {
	const candidate = await withCoreDb(env, (db) => loadTranslationCandidate(db, resourceId));
	if (!candidate?.hasContent || isWrittenInOriginal(candidate.originalLang, 'zh-Hant')) return { status: 'unavailable' as const };
	if (candidate.hasTranslatedContent) return { status: 'complete' as const };
	// A loaded candidate is translatable, so it always enqueues.
	const { execution } = (await enqueueResourceTranslation(candidate, 'full', false))!;
	return { status: 'running' as const, admitted: execution !== 'live' && execution !== 'done' };
}

/** Whether a requested full translation is still on its way; `idle` after it lands or fails. */
export async function contentTranslationStatus(env: CoreEnv, resourceId: string): Promise<'running' | 'idle'> {
	const candidate = await withCoreDb(env, (db) => loadTranslationCandidate(db, resourceId));
	if (!candidate || candidate.hasTranslatedContent) return 'idle';
	return (await translationExecution(translationInstanceId(resourceId, candidate.textHash, 'full'))) === 'live' ? 'running' : 'idle';
}

/** The sweep's retry of a Resource whose translation came due; a live one keeps running, and a gone one settles its rows. */
export async function resumeTranslation(db: NodePgDatabase, resourceId: string, textHash: string): Promise<void> {
	const candidate = await loadTranslationCandidate(db, resourceId);
	if (candidate?.textHash !== textHash) return settleOpenTranslations(db, resourceId, textHash, null);
	const enqueued = await enqueueResourceTranslation(candidate, candidate.automatic ? 'full' : 'metadata', false);
	// Every run now settles its rows, so one that completed with them open predates them: it runs again.
	if (enqueued?.execution === 'done') await (await coreExports.ResourceTranslationV2Workflow.get(enqueued.id)).restart();
}

// The Workflow

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(
		event: WorkflowEvent<ResourceTranslationPayload>,
		step: WorkflowStep,
	): Promise<{ status: 'complete' | 'skipped' | 'superseded'; resourceId: string }> {
		const { force = false, resourceId, textHash, scope } = event.payload;
		// Every run that publishes nothing ends here.
		const end = (status: 'skipped' | 'superseded', reason: string) => {
			console.info({ tag: 'RESOURCE_TRANSLATION', event: 'translation_outcome', outcome: status, reason, resource_id: resourceId });
			return { status, resourceId };
		};
		let corpus: boolean;
		try {
			const input = await stepJson(step, 'load-resource-translation-input-stream-v5', STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => loadResourceTranslationInput(db, resourceId)),
			);
			if (!input) return end('skipped', 'missing');
			if (input.textHash !== textHash) return end('superseded', 'superseded');
			const resource = input.resource;
			const plan = planTranslation(resource, scope, force);
			if (!plan.metadata && !plan.content && !plan.english)
				return await this.settle(step, resourceId, textHash, end('skipped', 'unneeded'));

			// Every part settles before any failure is raised, so no step is left running.
			const [metadata, content, english] = await Promise.allSettled([
				plan.metadata
					? step.do('translate-zh-hant-title-v4', { retries: AI_STEP_RETRIES, timeout: '180 seconds' }, () =>
							translateTitle(resource, 'zh-Hant', this.env),
						)
					: undefined,
				plan.content ? translateMarkdown(resource, this.env, step) : undefined,
				plan.english
					? step.do('translate-en-title-v2', { retries: AI_STEP_RETRIES, timeout: '180 seconds' }, () =>
							translateTitle(resource, 'en', this.env),
						)
					: undefined,
			]);
			if (metadata.status === 'rejected') throw metadata.reason;
			if (content.status === 'rejected') throw content.reason;
			if (english.status === 'rejected') throw english.reason;
			const patch = { ...metadata.value, ...content.value };
			const englishTitle = english.value?.title;
			const hasPatch = patch.title !== undefined || patch.content !== undefined;
			if (!hasPatch && englishTitle === undefined) return await this.settle(step, resourceId, textHash, end('skipped', 'empty'));

			if (hasPatch) {
				const persisted = await step.do('persist-zh-hant-translation-v2', STORAGE_STEP, async () =>
					withCoreDb(this.env, (db) => persistMachineTranslation(db, resourceId, textHash, 'zh-Hant', patch)),
				);
				if (!persisted) return end('superseded', 'persist-superseded');
			}
			if (englishTitle !== undefined) {
				const persisted = await step.do('persist-en-translation-v1', STORAGE_STEP, async () =>
					withCoreDb(this.env, (db) => persistMachineTranslation(db, resourceId, textHash, 'en', { title: englishTitle })),
				);
				if (!persisted) return end('superseded', 'persist-superseded');
			}
			console.info({
				tag: 'RESOURCE_TRANSLATION',
				event: 'translation_outcome',
				outcome: 'persisted',
				resource_id: resourceId,
				scope,
				translated_characters: patch.content?.length,
			});
			await this.settle(step, resourceId, textHash, null);
			corpus = resource.scope === 'corpus';
		} catch (error) {
			console.error({
				tag: 'RESOURCE_TRANSLATION',
				event: 'translation_outcome',
				outcome: 'failed',
				reason: failureReason(error),
				error: errorMessage(error),
				resource_id: resourceId,
			});
			await step.do('fail-open-translations-v1', STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => settleOpenTranslations(db, resourceId, textHash, failureReason(error))),
			);
			throw error;
		}
		// The translation is published, so a lost index handoff is logged rather than failing the run readers follow.
		if (corpus)
			await step
				.do('enqueue-translated-ai-search-sync-v1', STORAGE_STEP, async () => {
					await this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId });
				})
				.catch((error: unknown) => {
					console.error({ tag: 'RESOURCE_TRANSLATION', event: 'followup_dispatch_failed', error, resource_id: resourceId });
				});
		return { status: 'complete', resourceId };
	}

	/** Whatever this run left of its text's translations has nothing more coming from it. */
	private async settle<T>(step: WorkflowStep, resourceId: string, textHash: string, result: T): Promise<T> {
		await step.do('settle-open-translations-v1', STORAGE_STEP, () =>
			withCoreDb(this.env, (db) => settleOpenTranslations(db, resourceId, textHash, null)),
		);
		return result;
	}
}

// What to translate, and the title

function planTranslation(resource: ResourceTranslationInput, scope: TranslationScope, force: boolean) {
	const titled = RESOURCE_KINDS[resource.kind].titled;
	if ((titled && !resource.title.trim()) || !resource.content.trim()) {
		return { metadata: false, content: false, english: false };
	}
	const zhHant = !isWrittenInOriginal(resource.originalLang, 'zh-Hant');
	return {
		metadata: zhHant && titled && (force || !resource.hasTranslatedTitle),
		content: zhHant && scope === 'full' && (force || !resource.hasTranslatedContent),
		// An untitled Resource is its text alone, so only its content is translated, and never into English.
		english: !isWrittenInOriginal(resource.originalLang, 'en') && titled && (force || !resource.hasEnglishTitle),
	};
}
