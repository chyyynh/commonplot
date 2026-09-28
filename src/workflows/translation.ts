// Durable translation execution; resource processing only enqueues this Workflow.
import { hash } from 'node:crypto';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { isTranslatable, type ResourceTranslationCandidate } from '../contracts/translation-policy';
import { aiRetryDelay } from '../services/ai-model';
import { MarkdownTranslationInvariantError } from '../services/markdown-translation';
import { connectCoreDb } from '../store/db';
import {
	listMissingTranslations,
	loadResourceTranslationInput,
	type MachineZhHantTranslationPatch,
	OriginalHashSchema,
	persistMachineZhHantTranslation,
} from '../store/translations';
import { createResourceTask, type ResourceTaskContext } from './progress';
import { planZhHantTranslation, translatePlannedContent, translateResourceMetadata } from './translate-content';

type ResourceTranslationPayload = { force?: boolean; resourceId: string; originalHash: string };

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v33';
/** Follow one shared recovery chain, so concurrent imports cannot multiply paid work. */
async function currentTranslationAttempt(env: CoreEnv, resourceId: string, originalHash: string) {
	let id = `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${originalHash}`;
	for (let attempt = 0; attempt < 16; attempt++) {
		let snapshot: Awaited<ReturnType<WorkflowInstance['status']>>;
		try {
			snapshot = await (await env.RESOURCE_TRANSLATION_V2_WORKFLOW.get(id)).status();
		} catch {
			// An unavailable control plane cannot justify another physical task.
			// createBatch recovers this exact ID, including a lost response.
			return { id };
		}
		if (snapshot.status !== 'errored' && snapshot.status !== 'terminated') return { id, status: snapshot.status };
		if (attempt === 15) throw new Error('Translation retry limit reached');
		id = `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-retry-${resourceId}-${hash('sha256', id, 'hex').slice(0, 16)}`;
	}
	throw new Error('Translation retry limit reached');
}

// Normal ingestion dedupes by original hash. A forced run keys on its parent task instead, so every operator resync
// receives a fresh instance while retries of the same processing Workflow stay idempotent.
export async function enqueueResourceTranslation(
	env: CoreEnv,
	resource: ResourceTranslationCandidate & Readonly<{ id: string; originalHash: string }>,
	force: boolean,
	parent: ResourceTaskContext,
): Promise<string | null> {
	if (!isTranslatable(resource)) return null;
	const { id: resourceId, originalHash } = resource;
	OriginalHashSchema.parse(originalHash);
	const attempt = force
		? { id: `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-force-${resourceId}-${hash('sha256', parent.taskId, 'hex').slice(0, 16)}` }
		: await currentTranslationAttempt(env, resourceId, originalHash);
	const { id } = attempt;
	// Completed work already lives in ResourceTranslation. There is no new
	// execution to subscribe to, and no second source of progress to project.
	if ('status' in attempt && attempt.status === 'complete') return id;
	// Shared work owns a ledger from the beginning, including automatic work.
	// A later user subscribes to the same durable reports instead of polling it.
	const registered = await env.APP.registerResourceProgressTask({
		taskId: id,
		kind: 'translation',
		resourceId,
		...(parent.required ? { parentTaskId: parent.taskId } : {}),
	});
	if (!registered) throw new Error('Translation progress registration was rejected');
	await env.RESOURCE_TRANSLATION_V2_WORKFLOW.createBatch([
		{
			id,
			params: { ...(force ? { force: true } : {}), resourceId, originalHash },
		},
	]);
	return id;
}

// Kept small so recovery never crowds new imports out of the provider's per-minute window.
const TRANSLATION_SWEEP_BATCH = 25;

/** Re-admit recent corpus translations that never landed. */
export async function enqueueMissingTranslations(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	const rows = await listMissingTranslations(db, TRANSLATION_SWEEP_BATCH);
	const results = await Promise.allSettled(
		rows.map((row) => enqueueResourceTranslation(env, row, false, { taskId: 'translation-sweep', required: false })),
	);
	const failed = results.filter((result) => result.status === 'rejected').length;
	console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Missing translation sweep', admitted: rows.length - failed, failed });
}

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(
		event: WorkflowEvent<ResourceTranslationPayload>,
		step: WorkflowStep,
	): Promise<{ status: 'complete' | 'skipped' | 'superseded'; resourceId: string }> {
		const { force = false, resourceId, originalHash } = event.payload;
		const task = createResourceTask(this.env, step, event.instanceId);
		let translationPublished = false;
		let followupFailed = false;
		try {
			if (!(await task.start('translating'))) return { status: 'superseded', resourceId };
			const inputStream = await step.do<ReadableStream<Uint8Array> | null>(
				'load-resource-translation-input-stream-v5',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
				async () => {
					const input = await loadResourceTranslationInput(await connectCoreDb(this.env), resourceId);
					return input ? Response.json(input).body! : null;
				},
			);
			const input = inputStream ? await new Response(inputStream).json<Awaited<ReturnType<typeof loadResourceTranslationInput>>>() : null;
			if (!input) {
				console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Resource original is unavailable; skipping', resource_id: resourceId });
				await task.report('missing', { stage: 'translating', status: 'skipped', resourceId });
				return { status: 'skipped', resourceId };
			}
			if (input.originalHash !== originalHash) {
				console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Original changed since enqueue; skipping', resource_id: resourceId });
				await task.report('superseded', {
					stage: 'translating',
					status: 'superseded',
					resourceId,
				});
				return { status: 'superseded', resourceId };
			}

			const resource = input.resource;
			const translationPlan = planZhHantTranslation(resource, force);
			if (!translationPlan.metadata && !translationPlan.content) {
				await task.report('unneeded', { stage: 'translating', status: 'skipped', resourceId });
				return { status: 'skipped', resourceId };
			}

			const [metadata, content] = await Promise.allSettled([
				translationPlan.metadata
					? step.do(
							'translate-zh-hant-title-summary-v3',
							{ retries: { limit: 5, delay: aiRetryDelay, backoff: 'constant' }, timeout: '180 seconds' },
							() => translateResourceMetadata(resource, this.env),
						)
					: undefined,
				translationPlan.content
					? translatePlannedContent(
							resource.content,
							{ title: resource.title, summary: resource.summary },
							this.env,
							resourceId,
							step,
							task,
						)
					: undefined,
			]);
			if (content.status === 'rejected') {
				const error = content.reason;
				console.error({
					tag: 'RESOURCE_TRANSLATION',
					event: 'content_translation_outcome',
					outcome: 'failed',
					reason: error instanceof MarkdownTranslationInvariantError ? error.code : error instanceof Error ? error.name : 'unknown',
					error: error instanceof Error ? error.message : String(error),
					resource_id: resourceId,
				});
			}
			if (metadata.status === 'rejected') throw metadata.reason;
			if (content.status === 'rejected') throw content.reason;
			const patch: MachineZhHantTranslationPatch = { ...metadata.value, ...content.value };

			if (patch.title === undefined && patch.summary === undefined && patch.content === undefined) {
				await task.report('empty', { stage: 'translating', status: 'skipped', resourceId });
				return { status: 'skipped', resourceId };
			}

			const persisted = await step.do(
				'persist-zh-hant-translation-v2',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '30 seconds',
				},
				async () => persistMachineZhHantTranslation(await connectCoreDb(this.env), resourceId, originalHash, patch),
			);
			if (!persisted) {
				await task.report('persist-superseded', {
					stage: 'translating',
					status: 'superseded',
					resourceId,
				});
				if (patch.content !== undefined) {
					console.info({
						tag: 'RESOURCE_TRANSLATION',
						event: 'content_translation_outcome',
						outcome: 'superseded',
						resource_id: resourceId,
					});
				}
				return { status: 'superseded', resourceId };
			}
			if (patch.content !== undefined) {
				console.info({
					tag: 'RESOURCE_TRANSLATION',
					event: 'content_translation_outcome',
					outcome: 'persisted',
					resource_id: resourceId,
					translated_characters: patch.content.length,
				});
			}
			translationPublished = true;
			const followups = await Promise.allSettled([
				task.report('complete', { stage: 'translating', status: 'complete', resourceId }),
				resource.scope === 'corpus'
					? step.do(
							'enqueue-translated-ai-search-sync-v1',
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
							async () => {
								await this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId });
							},
						)
					: undefined,
			]);
			const failures = followups.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
			if (failures.length) throw new AggregateError(failures, 'Translation persisted, but follow-ups failed');
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Completed', resource_id: resourceId, scope: resource.scope });
			return { status: 'complete', resourceId };
		} catch (error) {
			followupFailed = translationPublished;
			await task.report('outcome-after-error', {
				status: translationPublished ? 'complete' : 'failed',
				resourceId,
				...(translationPublished ? {} : { errorCode: 'translation_failed' }),
			});
			if (translationPublished) {
				console.error({ tag: 'RESOURCE_TRANSLATION', event: 'followup_dispatch_failed', resource_id: resourceId, error });
			}
			throw error;
		} finally {
			await task.seal(followupFailed ? 'followup_dispatch_failed' : undefined);
		}
	}
}
