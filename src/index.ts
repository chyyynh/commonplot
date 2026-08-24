import { WorkerEntrypoint } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type {} from './env';
import { handleRSSCron, resolveFeedMonitoredSource } from './ingest/platforms/rss';
import { handleTwitterCron, resolveTwitterMonitoredSource } from './ingest/platforms/twitter';
import { resolveYouTubeMonitoredSource } from './ingest/platforms/youtube';
import { ResourceTranslationV2Workflow } from './ingest/translation-workflow';
import { type ResourceDraftTarget, ResourceDraftTargetSchema, ResourceProcessingV2Workflow } from './ingest/workflow';
import { SearchIndexGeneration5RebuildWorkflow } from './operations/search-index-rebuild';
import { type PublicResourceSearchInput, searchPublicResourceIds } from './search-index';
import { connectCoreDb } from './shared/db';

export { ResourceProcessingV2Workflow, ResourceTranslationV2Workflow, SearchIndexGeneration5RebuildWorkflow };

type AppResourceDraftInput = Readonly<{
	instanceId: string;
	url: string;
	saveTarget: Exclude<ResourceDraftTarget['saveTarget'], undefined>;
}>;

type StoredPdfProcessingInput = Readonly<{ resourceId: string }>;

const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const STORED_BLOB_WORKFLOW_REVISION = 'stored-resource-v11';
const STORED_BLOB_WORKFLOW_RETENTION = {
	successRetention: '5 minutes',
	errorRetention: '1 hour',
} as const;

function storedBlobWorkflowInstance(resourceId: string) {
	const id = z.uuid().parse(resourceId);
	return {
		id: `${STORED_BLOB_WORKFLOW_REVISION}-${id}`,
		params: { kind: 'storedBlob' as const, resourceId: id },
		retention: STORED_BLOB_WORKFLOW_RETENTION,
	};
}

/** Repairs only interrupted DB-to-Workflow handoffs for record-first app-owned blobs. */
async function reconcilePendingBlobProcessing(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	const result = await db.execute<{ resource_id: string }>(sql`
		SELECT resource.id::text AS resource_id
		FROM resources resource
		WHERE resource.enrichment_status = 'pending'
		  AND resource.scope = 'private'
		  AND resource.kind = 'blog'
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
	const created = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(resourceIds.map(storedBlobWorkflowInstance));
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'pending_blob_reconciliation_completed',
		attempted: resourceIds.length,
		created: created.length,
		existing: resourceIds.length - created.length,
	});
}

const ResourceWorkflowErroredEventSchema = z.object({
	type: z.literal('cf.workflows.workflow.instance.errored'),
	source: z.object({
		type: z.literal('workflows.workflow'),
		workflowName: z.literal('newsence-resource-processing-v2'),
	}),
	payload: z.object({
		instanceId: z.string().min(1).max(100),
		versionId: z.string().min(1),
	}),
});

async function runFiveMinuteCycle(env: CoreEnv): Promise<void> {
	const db = await connectCoreDb(env);
	const results = await Promise.allSettled([handleRSSCron(env, db), reconcilePendingBlobProcessing(env, db)]);
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
	if (failures.length) {
		throw new AggregateError(
			failures.map(({ reason }) => reason),
			'One or more five-minute core jobs failed',
		);
	}
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

	override queue(batch: MessageBatch<unknown>): void {
		for (const message of batch.messages) {
			const event = ResourceWorkflowErroredEventSchema.safeParse(message.body);
			if (!event.success) {
				console.warn({ tag: 'WORKFLOW', event: 'workflow_error_event_invalid', message_id: message.id });
				message.ack();
				continue;
			}
			const { instanceId, versionId } = event.data.payload;
			console.error({
				tag: 'WORKFLOW',
				event: 'workflow_instance_errored',
				workflow: event.data.source.workflowName,
				instance_id: instanceId,
				version_id: versionId,
			});
			message.ack();
		}
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue an app-owned blob after its R2 object and private ownership row exist. */
	async enqueueResourceProcessing(input: StoredPdfProcessingInput) {
		const instance = storedBlobWorkflowInstance(input.resourceId);
		await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([instance]);
		return instance.id;
	}

	/** Process an external URL before its canonical Resource and user relation become visible. */
	async enqueueResourceDraft(input: AppResourceDraftInput): Promise<string> {
		if (!/^app-draft-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.instanceId)) {
			throw new Error('Invalid app draft Workflow ID');
		}
		const parsedUrl = URL.parse(input.url);
		if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.username || parsedUrl.password) {
			throw new Error('Only http(s) URLs without credentials are allowed');
		}
		const target = ResourceDraftTargetSchema.parse({
			kind: 'draft',
			saveTarget: input.saveTarget,
			url: parsedUrl.toString(),
		});
		await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id: input.instanceId, params: target }]);
		return input.instanceId;
	}

	/** Reacquire a URL-backed resource through the enrichment workflow. */
	async resyncResource(resourceId: string) {
		const id = z.uuid().parse(resourceId);
		const instance = await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
			id: `resource-resync-v3-${id}-${crypto.randomUUID()}`,
			params: { kind: 'reacquire', resourceId: id },
		});
		return instance.id;
	}

	/** AI Search candidates; the app Worker authoritatively filters and hydrates them. */
	searchPublicResourceIds(input: PublicResourceSearchInput) {
		return searchPublicResourceIds(this.env, input);
	}

	/** Read workflow status for app-side polling. */
	async getWorkflowStatus(instanceId: string) {
		const instance = await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.get(instanceId);
		return instance.status();
	}

	/** Resolve a feed/account/channel monitor into a source row candidate (#237). */
	async resolveMonitoredSource(input: string) {
		const raw = typeof input === 'string' ? input.trim() : '';
		if (!raw) throw new Error('Source input is required.');
		const parsedUrl = URL.parse(raw);
		const url =
			parsedUrl && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') && !parsedUrl.username && !parsedUrl.password
				? parsedUrl
				: null;
		const youtube = await resolveYouTubeMonitoredSource(this.env.YOUTUBE_API_KEY, raw, url);
		if (youtube) return youtube;
		const twitter = resolveTwitterMonitoredSource(raw, url);
		if (twitter) return twitter;
		if (url) return resolveFeedMonitoredSource(url);
		throw new Error('Enter a feed URL, YouTube channel URL or ID, or X/Twitter handle.');
	}
}
