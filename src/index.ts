import { WorkerEntrypoint } from 'cloudflare:workers';
import { connectCoreDb } from '@db/connection';
import { resolveMonitoredSource } from '@ingest/monitored-source';
import { handleRSSCron } from '@ingest/platforms/rss';
import { handleTwitterCron } from '@ingest/platforms/twitter';
import { type AppResourceDraftInput, enqueueAppResourceDraft, SourceResourceRecoveryWorkflow } from '@ingest/processing-jobs';
import {
	enqueueProcessing,
	enqueueResourceResync,
	reconcilePendingBlobProcessing,
	type StoredPdfProcessingInput,
} from '@ingest/stored-resource';
import { ResourceTranslationV2Workflow } from '@ingest/translation-workflow';
import { ResourceProcessingV2Workflow } from '@ingest/workflow';
import { z } from 'zod';
import { SearchIndexGeneration5RebuildWorkflow } from './ai-search';
import { type PublicResourceSearchInput, searchPublicResourceIds } from './public-search';

export {
	ResourceProcessingV2Workflow,
	ResourceTranslationV2Workflow,
	SearchIndexGeneration5RebuildWorkflow,
	SourceResourceRecoveryWorkflow,
};

const ResourceWorkflowErroredEventSchema = z.object({
	type: z.literal('cf.workflows.workflow.instance.errored'),
	source: z.object({
		type: z.literal('workflows.workflow'),
		workflowName: z.string().min(1),
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

	override async queue(batch: MessageBatch<unknown>): Promise<void> {
		const sourceInstanceIds = new Set<string>();
		for (const message of batch.messages) {
			const event = ResourceWorkflowErroredEventSchema.safeParse(message.body);
			if (!event.success) {
				console.warn({ tag: 'WORKFLOW', event: 'workflow_error_event_invalid', message_id: message.id });
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
			if (/^source-draft-v[1-9]\d*-[0-9a-f]{64}$/.test(instanceId)) sourceInstanceIds.add(instanceId);
		}
		if (!sourceInstanceIds.size) return;

		const recoveries = [...sourceInstanceIds].map((instanceId) => ({
			id: `source-recovery-v1-${instanceId.slice('source-draft-'.length)}`,
			params: { instanceId },
		}));
		const created = await this.env.SOURCE_RESOURCE_RECOVERY_WORKFLOW.createBatch(recoveries);
		console.info({
			tag: 'SOURCE_RECOVERY',
			event: 'source_resource_recoveries_admitted',
			received: recoveries.length,
			created: created.length,
			deduplicated: recoveries.length - created.length,
		});
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue an app-owned blob after its R2 object and private ownership row exist. */
	async enqueueResourceProcessing(input: StoredPdfProcessingInput) {
		return enqueueProcessing(this.env, input);
	}

	/** Process an external URL before its canonical Resource and user relation become visible. */
	enqueueResourceDraft(input: AppResourceDraftInput) {
		return enqueueAppResourceDraft(this.env, input);
	}

	/** Reacquire a URL-backed resource through the enrichment workflow. */
	resyncResource(resourceId: string) {
		return enqueueResourceResync(this.env, resourceId);
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
	resolveMonitoredSource(input: string) {
		return resolveMonitoredSource(this.env, input);
	}
}
