import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type {} from './env';
import { GrobidContainer } from './ingest/grobid-container';
import { handleRSSCron } from './ingest/platforms/rss';
import { handleTwitterCron } from './ingest/platforms/twitter';
import { ResourceReferenceEnrichmentWorkflow } from './ingest/resource-references';
import { ResourceTranslationV2Workflow } from './ingest/translation-workflow';
import {
	type ResourceDraftTarget,
	ResourceDraftTargetSchema,
	ResourceProcessingV2Workflow,
	StoredResourceTargetSchema,
} from './ingest/workflow';
import { ZoteroSdtContainer } from './ingest/zotero-sdt-container';
import { SearchIndexRebuildWorkflow } from './operations/search-index-rebuild';
import {
	loadCorpusDocuments,
	type PublicResourceSearchInput,
	type RelatedResourceSearchInput,
	searchPublicResourceIds,
	searchRelatedResourceIds,
	syncCorpusItem,
} from './search-index';
import { connectCoreDb } from './shared/db';

export {
	GrobidContainer,
	ResourceProcessingV2Workflow,
	ResourceReferenceEnrichmentWorkflow,
	ResourceTranslationV2Workflow,
	SearchIndexRebuildWorkflow,
	ZoteroSdtContainer,
};

const StoredPdfProcessingInputSchema = StoredResourceTargetSchema.omit({ kind: true }).extend({
	retry: z.boolean().optional(),
});

const ResourceImportDispatchSchema = z.strictObject({
	workflowId: z.string().pipe(z.templateLiteral(['app-ingest-v1-', z.uuidv4()])),
	payload: z.discriminatedUnion('kind', [ResourceDraftTargetSchema, StoredResourceTargetSchema.extend({ kind: z.literal('storedBlob') })]),
});

const ResourceSearchSyncMessageSchema = z.strictObject({
	resourceId: z.uuid().toLowerCase(),
	taskId: z.string().min(1).max(150).optional(),
});

// Kept aligned with resource-search-sync.max_retries in wrangler.jsonc.
const SEARCH_SYNC_MAX_RETRIES = 3;
async function retrySearchMessages(env: CoreEnv, messages: Message<unknown>[], indexedOutcome?: 'complete' | 'skipped') {
	const tasks = new Map<string, Message<unknown>[]>();
	for (const message of messages) {
		const body = ResourceSearchSyncMessageSchema.parse(message.body);
		if (body.taskId) tasks.set(body.taskId, [...(tasks.get(body.taskId) ?? []), message]);
	}
	for (const [taskId, deliveries] of tasks) {
		if (deliveries.every((message) => message.attempts > SEARCH_SYNC_MAX_RETRIES)) {
			await env.APP.reportResourceProgress({
				taskId,
				stage: 'indexing',
				status: indexedOutcome ?? 'failed',
				...(indexedOutcome ? {} : { errorCode: 'index_failed' }),
			});
			await env.APP.sealResourceProgressTask(taskId);
		}
	}
	for (const message of messages) message.retry();
}

export default class CoreWorker extends WorkerEntrypoint<CoreEnv> {
	override fetch(_request: Request): Response {
		return new Response('Not found', { status: 404 });
	}

	override scheduled(event: ScheduledController): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

		// YouTube channels ride the feed monitor through their Atom URLs; Core
		// derives their slower polling cadence from the canonical feed URL.
		if (event.cron === '*/5 * * * *') {
			this.ctx.waitUntil(connectCoreDb(this.env).then((db) => handleRSSCron(this.env, db)));
		} else if (event.cron === '0 */6 * * *') {
			this.ctx.waitUntil(handleTwitterCron(this.env, new Date(event.scheduledTime)));
		}
	}

	override async queue(batch: MessageBatch<unknown>): Promise<void> {
		const pending = new Map<string, Message<unknown>[]>();
		for (const message of batch.messages) {
			const input = ResourceSearchSyncMessageSchema.safeParse(message.body);
			if (!input.success) {
				console.warn({ tag: 'AI_SEARCH', msg: 'Invalid resource sync message', message_id: message.id });
				message.ack();
				continue;
			}
			const messages = pending.get(input.data.resourceId) ?? [];
			messages.push(message);
			pending.set(input.data.resourceId, messages);
		}
		if (!pending.size) return;
		let documents: Awaited<ReturnType<typeof loadCorpusDocuments>>;
		try {
			documents = await loadCorpusDocuments(await connectCoreDb(this.env), [...pending.keys()]);
		} catch (error) {
			console.error({ tag: 'AI_SEARCH', msg: 'Resource sync batch could not be loaded', error });
			for (const messages of pending.values()) {
				await retrySearchMessages(this.env, messages);
			}
			return;
		}
		const documentsById = new Map(documents.map((document) => [document.id, document]));
		for (const [resourceId, messages] of pending) {
			let indexedOutcome: 'complete' | 'skipped' | undefined;
			try {
				const taskIds = [
					...new Set(
						messages.flatMap((message) => {
							const body = ResourceSearchSyncMessageSchema.parse(message.body);
							return body.taskId ? [body.taskId] : [];
						}),
					),
				];
				for (const taskId of taskIds)
					await this.env.APP.reportResourceProgress({ taskId, stage: 'indexing', status: 'running', resourceId });
				await syncCorpusItem(this.env, resourceId, documentsById.get(resourceId));
				indexedOutcome = documentsById.has(resourceId) ? 'complete' : 'skipped';
				for (const taskId of taskIds) {
					await this.env.APP.reportResourceProgress({
						taskId,
						stage: 'indexing',
						status: documentsById.has(resourceId) ? 'complete' : 'skipped',
						resourceId,
					});
					await this.env.APP.sealResourceProgressTask(taskId);
				}
				for (const message of messages) message.ack();
			} catch (error) {
				console.error({
					tag: 'AI_SEARCH',
					msg: 'Resource sync failed',
					resource_id: resourceId,
					attempt: Math.max(...messages.map((message) => message.attempts)),
					error,
				});
				await retrySearchMessages(this.env, messages, indexedOutcome);
			}
		}
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue an app-owned blob after its R2 object and private ownership row exist. */
	async enqueueResourceProcessing(input: z.infer<typeof StoredPdfProcessingInputSchema>) {
		const parsed = StoredPdfProcessingInputSchema.parse(input);
		return this.env.APP.admitStoredBlobProcessing(parsed);
	}

	/** Durable admission outbox: the caller persists this immutable ID and payload first. */
	async dispatchResourceImport(input: z.input<typeof ResourceImportDispatchSchema>): Promise<void> {
		const parsed = ResourceImportDispatchSchema.parse(input);
		// The admission DO waits for committed ownership. The Workflow rechecks
		// ownership and the latest attempt before provider execution, after any
		// queueing delay; another callback here cannot replace that execution gate.
		await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([
			{ id: parsed.workflowId, params: parsed.payload, retention: { successRetention: '5 minutes', errorRetention: '7 days' } },
		]);
	}

	/** Reacquire a URL-backed resource through the enrichment workflow. */
	async resyncResource(resourceId: string, paidPdfFallback?: ResourceDraftTarget['paidPdfFallback']) {
		const id = z.uuid().parse(resourceId);
		const grant = ResourceDraftTargetSchema.shape.paidPdfFallback.parse(paidPdfFallback);
		const instance = await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
			id: `resource-resync-v3-${id}-${crypto.randomUUID()}`,
			params: { kind: 'reacquire', ...(grant ? { paidPdfFallback: grant } : {}), resourceId: id },
		});
		return instance.id;
	}

	/** Ranked AI Search candidates; the app Worker authoritatively filters and hydrates them. */
	searchPublicResourceIds(input: PublicResourceSearchInput) {
		return searchPublicResourceIds(this.env, input);
	}

	/** Resource-level semantic neighbors; the app Worker authoritatively filters and hydrates them. */
	async searchRelatedResourceIds(input: RelatedResourceSearchInput) {
		return searchRelatedResourceIds(this.env, await connectCoreDb(this.env), input);
	}
}
