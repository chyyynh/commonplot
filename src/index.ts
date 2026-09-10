import { WorkerEntrypoint } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type {} from './env';
import { GrobidContainer } from './ingest/grobid-container';
import { handleRSSCron } from './ingest/platforms/rss';
import { handleTwitterCron } from './ingest/platforms/twitter';
import { ResourceReferenceEnrichmentWorkflow } from './ingest/resource-references';
import { readResourceTranslationStatus, ResourceTranslationV2Workflow } from './ingest/translation-workflow';
import { type ResourceDraftTarget, ResourceDraftTargetSchema, ResourceProcessingV2Workflow } from './ingest/workflow';
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

type AppResourceDraftInput = Readonly<{
	instanceId: string;
	paidPdfFallback?: ResourceDraftTarget['paidPdfFallback'];
	url: string;
	saveTarget: Exclude<ResourceDraftTarget['saveTarget'], undefined>;
}>;

const StoredPdfProcessingInputSchema = z.strictObject({
	paidPdfFallback: ResourceDraftTargetSchema.shape.paidPdfFallback,
	resourceId: z.uuid(),
	retry: z.boolean().optional(),
});

const APP_RESOURCE_BATCH_LIMIT = 20;
const AppDraftWorkflowIdSchema = z.templateLiteral(['app-draft-v1-', z.uuidv4()]);
const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const STORED_BLOB_WORKFLOW_REVISION = 'stored-resource-v13';
function storedBlobWorkflowInstance(resourceId: string, paidPdfFallback?: ResourceDraftTarget['paidPdfFallback'], retryId?: string) {
	return {
		id: retryId ? `${STORED_BLOB_WORKFLOW_REVISION}-${resourceId}-retry-${retryId}` : `${STORED_BLOB_WORKFLOW_REVISION}-${resourceId}`,
		params: { kind: 'storedBlob' as const, ...(paidPdfFallback ? { paidPdfFallback } : {}), resourceId },
		retention: {
			successRetention: '5 minutes',
			errorRetention: '1 hour',
		} as const,
	};
}

/** Repairs only interrupted DB-to-Workflow handoffs for record-first app-owned blobs. */
async function reconcilePendingBlobProcessing(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	const result = await db.execute<{ resource_id: string }>(sql`
		SELECT resource.id::text AS resource_id
		FROM resources resource
		WHERE resource.enrichment_status = 'pending'
		  AND resource.scope = 'private'
		  AND resource.kind = 'file'
		  AND resource.resource_platform IS NULL
		  AND resource.file_type = 'application/pdf'
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (
		    SELECT 1
		    FROM user_files
		    WHERE user_files.resource_id = resource.id
		  )
		  AND resource.updated_at < ${new Date(Date.now() - PENDING_BLOB_GRACE_MS)}
		ORDER BY resource.updated_at ASC, resource.id ASC
		LIMIT ${PENDING_BLOB_RECONCILE_LIMIT}
	`);
	const resourceIds = result.rows.map((row) => row.resource_id);
	if (!resourceIds.length) return;
	const created = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(
		resourceIds.map((resourceId) => storedBlobWorkflowInstance(resourceId)),
	);
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'pending_blob_reconciliation_completed',
		attempted: resourceIds.length,
		created: created.length,
		existing: resourceIds.length - created.length,
	});
}

const ResourceSearchSyncMessageSchema = z.strictObject({ resourceId: z.uuid().toLowerCase() });
const ResourceWorkflowOutputSchema = z.object({ resourceId: z.uuid() });

async function runFiveMinuteCycle(env: CoreEnv): Promise<void> {
	const db = await connectCoreDb(env);
	const results = await Promise.allSettled([handleRSSCron(env, db), reconcilePendingBlobProcessing(env, db)]);
	const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
	if (failures.length) throw new AggregateError(failures, 'One or more five-minute core jobs failed');
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
			this.ctx.waitUntil(runFiveMinuteCycle(this.env));
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
				for (const message of messages) message.retry();
			}
			return;
		}
		const documentsById = new Map(documents.map((document) => [document.id, document]));
		for (const [resourceId, messages] of pending) {
			try {
				await syncCorpusItem(this.env, resourceId, documentsById.get(resourceId));
				for (const message of messages) message.ack();
			} catch (error) {
				console.error({
					tag: 'AI_SEARCH',
					msg: 'Resource sync failed',
					resource_id: resourceId,
					attempt: Math.max(...messages.map((message) => message.attempts)),
					error,
				});
				for (const message of messages) message.retry();
			}
		}
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue an app-owned blob after its R2 object and private ownership row exist. */
	async enqueueResourceProcessing(input: z.infer<typeof StoredPdfProcessingInputSchema>) {
		const parsed = StoredPdfProcessingInputSchema.parse(input);
		const instance = storedBlobWorkflowInstance(parsed.resourceId, parsed.paidPdfFallback, parsed.retry ? crypto.randomUUID() : undefined);
		await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([instance]);
		return instance.id;
	}

	/** Process external URLs before their canonical Resources and user relations become visible. */
	async enqueueResourceDrafts(inputs: AppResourceDraftInput[]): Promise<void> {
		if (!Array.isArray(inputs) || !inputs.length || inputs.length > APP_RESOURCE_BATCH_LIMIT) {
			throw new Error(`Resource draft batch must contain 1-${APP_RESOURCE_BATCH_LIMIT} items`);
		}
		const instances = inputs.map((input) => ({
			id: AppDraftWorkflowIdSchema.parse(input.instanceId),
			params: ResourceDraftTargetSchema.parse({
				kind: 'draft',
				...(input.paidPdfFallback ? { paidPdfFallback: input.paidPdfFallback } : {}),
				saveTarget: input.saveTarget,
				url: input.url,
			}),
		}));
		await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(instances);
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

	/** Read the current translation revision's status after app-owned authorization. */
	getResourceTranslationStatus(resourceId: string): Promise<string | null> {
		return readResourceTranslationStatus(this.env, resourceId);
	}

	/** Read a bounded set of workflow statuses for app-side polling. */
	async getResourceWorkflowStatuses(instanceIds: string[]) {
		const ids = z.array(z.string().trim().min(1).max(100)).min(1).max(APP_RESOURCE_BATCH_LIMIT).parse(instanceIds);
		return Promise.all(
			ids.map(async (instanceId) => {
				try {
					const instance = await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.get(instanceId);
					const state = await instance.status();
					const output = ResourceWorkflowOutputSchema.safeParse(state.output);
					return {
						status: state.status,
						...(output.success ? { resourceId: output.data.resourceId } : {}),
					};
				} catch (error) {
					console.error({
						tag: 'RESOURCE_WORKFLOW',
						event: 'status_unavailable',
						instance_id: instanceId,
						error,
					});
					return null;
				}
			}),
		);
	}
}
