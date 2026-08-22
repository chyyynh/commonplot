import { WorkerEntrypoint } from 'cloudflare:workers';
import { connectCoreDb } from '@db/connection';
import { type ResolveMonitoredSourceInput, resolveMonitoredSource } from '@ingest/monitored-source';
import { handleRSSCron } from '@ingest/platforms/rss';
import { handleTwitterCron } from '@ingest/platforms/twitter';
import {
	type AppResourceDraftInput,
	enqueueAppResourceDraft,
	enqueueProcessing,
	enqueueResourceResync,
	reconcilePendingBlobProcessing,
} from '@ingest/resource-admission';
import { ResourceTranslationV2Workflow } from '@ingest/resource-translation-workflow';
import { ResourceProcessingV2Workflow } from '@ingest/workflow';
import { SearchIndexGeneration5RebuildWorkflow } from './ai-search';
import { assertResourceProcessable } from './ingest/domain/resource-store';
import { type PublicResourceSearchInput, searchPublicResourceIds } from './public-search';

export { ResourceProcessingV2Workflow, ResourceTranslationV2Workflow, SearchIndexGeneration5RebuildWorkflow };

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
		// derives their slower polling cadence from platform.
		if (event.cron === '*/5 * * * *') {
			this.ctx.waitUntil(runFiveMinuteCycle(this.env));
		} else if (event.cron === '0 */6 * * *') {
			this.ctx.waitUntil(handleTwitterCron(this.env, new Date(event.scheduledTime)));
		}
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue an app-owned blob after its R2 object and private ownership row exist. */
	async enqueueResourceProcessing(resourceId: string) {
		return enqueueProcessing(this.env, resourceId);
	}

	/** Process an external URL before its canonical Resource and user relation become visible. */
	enqueueResourceDraft(input: AppResourceDraftInput) {
		return enqueueAppResourceDraft(this.env, input);
	}

	/** Reacquire a URL-backed resource through the enrichment workflow. */
	async resyncResource(resourceId: string) {
		const db = await connectCoreDb(this.env);
		await assertResourceProcessable(db, resourceId);
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

	/** Resolve an explicitly requested feed/account/channel monitor into a source row candidate (#237). */
	resolveMonitoredSource(input: ResolveMonitoredSourceInput) {
		return resolveMonitoredSource(this.env, input);
	}
}
