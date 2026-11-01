// A Resource's content translation into one language: admission (automatic ones at write time, reader requests, the
// derivation sweep) and the durable Workflow that loads, translates and stores it. Titles are not translated here: each
// summary language's card carries its own. The translating itself is services/translation, which knows nothing of
// Resources.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { CONTENT_TRANSLATION_LANGS, type ContentTranslationLang } from '../contracts/languages';
import { coreExports, workflowStatus } from '../exports.ts';
import { errorMessage } from '../services/response';
import { failureReason, translateMarkdown } from '../services/translation';
import { STORAGE_STEP, stepJson } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import {
	failDerivation,
	isTranslatable,
	loadImportDerivationStates,
	loadResourceTranslationInput,
	loadTranslationCandidate,
	persistMachineTranslation,
	type ResourceTranslationCandidate,
	settleOpenTranslation,
	TextHashSchema,
} from '../store/derivations';

// A run queued before `lang` was its parameter fails this parse and ends; the sweep starts its replacement.
const ResourceTranslationPayloadSchema = z.object({
	force: z.boolean().optional(),
	resourceId: z.uuid(),
	textHash: TextHashSchema,
	lang: z.enum(CONTENT_TRANSLATION_LANGS),
});
type ResourceTranslationPayload = z.infer<typeof ResourceTranslationPayloadSchema>;

// Admission

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v37';

// One execution per original and language: concurrent imports, requests and the sweep all meet on this ID, so paid work
// is never doubled, and a changed original gets a new one. Its translation row, not the execution, says whether it landed.
function translationInstanceId(resourceId: string, textHash: string, lang: ContentTranslationLang): string {
	return `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${lang}-${resourceId}-${textHash}`;
}

async function translationExecution(id: string) {
	const status = await workflowStatus(coreExports.ResourceTranslationV2Workflow, id);
	// An absent one, even one the control plane only failed to find, is recovered by createBatch under this exact ID.
	if (status === 'absent') return status;
	if (status === 'errored' || status === 'terminated') return 'rerun' as const;
	return status === 'complete' ? ('done' as const) : ('live' as const);
}

/** What an import shows for its derivations: running while a card or translation is open or one is live, failed once one failed. */
export async function importProgress(db: NodePgDatabase, resourceId: string, textHash: string): Promise<'running' | 'failed' | undefined> {
	const [states, executions] = await Promise.all([
		loadImportDerivationStates(db, resourceId, textHash),
		Promise.all(CONTENT_TRANSLATION_LANGS.map((lang) => translationExecution(translationInstanceId(resourceId, textHash, lang)))),
	]);
	if (states.includes('pending') || executions.includes('live')) return 'running';
	if (states.includes('failed') || executions.includes('rerun')) return 'failed';
	return undefined;
}

// `execution` is what the same work was before this call: live and done ones are left alone.
export async function enqueueResourceTranslation(
	resource: ResourceTranslationCandidate & Readonly<{ id: string; textHash: string }>,
	lang: ContentTranslationLang,
	force: boolean,
) {
	if (!isTranslatable(resource, lang)) return null;
	const { id: resourceId, textHash } = resource;
	TextHashSchema.parse(textHash);
	const id = translationInstanceId(resourceId, textHash, lang);
	const execution = await translationExecution(id);
	// Completed work already lives in its translation row. There is no new
	// execution to subscribe to, and no second source of progress to project.
	if (execution === 'done') return { id, execution };
	// Concurrent callers share one execution; a failed one runs again under the same ID.
	if (execution === 'rerun') await (await coreExports.ResourceTranslationV2Workflow.get(id)).restart();
	if (execution === 'absent') {
		await coreExports.ResourceTranslationV2Workflow.createBatch([
			{ id, params: { ...(force ? { force: true } : {}), resourceId, textHash, lang } satisfies ResourceTranslationPayload },
		]);
	}
	return { id, execution };
}

/** A reader's request for a stored Resource's content in `lang`; the app Worker admits and bills it first. */
export async function requestContentTranslation(env: CoreEnv, resourceId: string, lang: ContentTranslationLang) {
	const candidate = await withCoreDb(env, (db) => loadTranslationCandidate(db, resourceId, lang));
	if (!candidate?.hasContent) return { status: 'unavailable' as const };
	if (candidate.hasTranslatedContent) return { status: 'complete' as const };
	// A loaded candidate is translatable, so it always enqueues.
	const { execution } = (await enqueueResourceTranslation(candidate, lang, false))!;
	return { status: 'running' as const, admitted: execution !== 'live' && execution !== 'done' };
}

/** Whether a requested translation into `lang` is still on its way; `idle` after it lands or fails. */
export async function contentTranslationStatus(
	env: CoreEnv,
	resourceId: string,
	lang: ContentTranslationLang,
): Promise<'running' | 'idle'> {
	const candidate = await withCoreDb(env, (db) => loadTranslationCandidate(db, resourceId, lang));
	if (!candidate || candidate.hasTranslatedContent) return 'idle';
	return (await translationExecution(translationInstanceId(resourceId, candidate.textHash, lang))) === 'live' ? 'running' : 'idle';
}

/** The sweep's retry of a translation that came due; a live one keeps running, and a gone one settles its row. */
export async function resumeTranslation(db: NodePgDatabase, resourceId: string, textHash: string, lang: ContentTranslationLang) {
	const candidate = await loadTranslationCandidate(db, resourceId, lang);
	if (candidate?.textHash !== textHash) return settleOpenTranslation(db, resourceId, textHash, lang);
	const enqueued = await enqueueResourceTranslation(candidate, lang, false);
	// Every run now settles its row, so one that completed with it open predates it: it runs again.
	if (enqueued?.execution === 'done') await (await coreExports.ResourceTranslationV2Workflow.get(enqueued.id)).restart();
}

// The Workflow

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(
		event: WorkflowEvent<ResourceTranslationPayload>,
		step: WorkflowStep,
	): Promise<{ status: 'complete' | 'skipped' | 'superseded'; resourceId: string }> {
		const payload = ResourceTranslationPayloadSchema.safeParse(event.payload);
		const resourceId = String(event.payload.resourceId);
		// Every run that publishes nothing ends here.
		const end = (status: 'skipped' | 'superseded', reason: string) => {
			console.info({ tag: 'RESOURCE_TRANSLATION', event: 'translation_outcome', outcome: status, reason, resource_id: resourceId });
			return { status, resourceId };
		};
		if (!payload.success) return end('skipped', 'stale-payload');
		const { force = false, textHash, lang } = payload.data;
		let corpus: boolean;
		try {
			const input = await stepJson(step, `load-resource-translation-input-${lang}-v6`, STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => loadResourceTranslationInput(db, resourceId, lang)),
			);
			if (!input) return end('skipped', 'missing');
			if (input.textHash !== textHash) return end('superseded', 'superseded');
			const resource = input.resource;
			if (!resource.content.trim() || (resource.hasTranslatedContent && !force))
				return await this.settle(step, resourceId, textHash, lang, end('skipped', 'unneeded'));

			const content = await translateMarkdown(resource, lang, this.env, step);
			if (!content) return await this.settle(step, resourceId, textHash, lang, end('skipped', 'empty'));
			const persisted = await step.do(`persist-${lang.toLowerCase()}-translation-v3`, STORAGE_STEP, async () =>
				withCoreDb(this.env, (db) => persistMachineTranslation(db, resourceId, textHash, lang, content)),
			);
			if (!persisted) return end('superseded', 'persist-superseded');
			console.info({
				tag: 'RESOURCE_TRANSLATION',
				event: 'translation_outcome',
				outcome: 'persisted',
				resource_id: resourceId,
				lang,
				translated_characters: content.content.length,
			});
			await this.settle(step, resourceId, textHash, lang, null);
			corpus = resource.scope === 'corpus';
		} catch (error) {
			console.error({
				tag: 'RESOURCE_TRANSLATION',
				event: 'translation_outcome',
				outcome: 'failed',
				reason: failureReason(error),
				error: errorMessage(error),
				resource_id: resourceId,
				lang,
			});
			await step.do(`fail-open-translation-${lang.toLowerCase()}-v2`, STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => failDerivation(db, resourceId, { kind: 'translation', lang }, textHash, failureReason(error))),
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

	/** Whatever this run left of its translation has nothing more coming from it. */
	private async settle<T>(step: WorkflowStep, resourceId: string, textHash: string, lang: ContentTranslationLang, result: T): Promise<T> {
		await step.do(`settle-open-translation-${lang.toLowerCase()}-v2`, STORAGE_STEP, () =>
			withCoreDb(this.env, (db) => settleOpenTranslation(db, resourceId, textHash, lang)),
		);
		return result;
	}
}
