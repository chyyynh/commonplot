import { WorkerEntrypoint } from 'cloudflare:workers';
import type { KnowledgeResolveResourcesInput, KnowledgeResourceReadInput } from '@app-domain/knowledge-contracts';
import { type ResolveMonitoredSourceInput, resolveMonitoredSource } from '@ingest/monitored-source';
import { handleRSSCron } from '@ingest/platforms/rss';
import { handleTwitterCron } from '@ingest/platforms/twitter';
import { ResourceTranslationV2Workflow } from '@ingest/resource-translation-workflow';
import {
	enqueueProcessing,
	enqueueResourceResync,
	ResourceProcessingV2Workflow,
	reconcilePendingResourceProcessing,
} from '@ingest/workflow';
import { SearchIndexGeneration5RebuildWorkflow } from './ai-search';
import type { RelatedResourceSearchInput, ResourceSearchInput } from './corpus';
import { relatedCorpusResourceIds, searchCorpusResourceRanks, searchCorpusResources } from './corpus';
import { readCorpusResource, resolveCorpusResources } from './corpus-retrieval';
import { assertResourceProcessable, isResourceEnrichmentComplete } from './ingest/domain/resource-store';

export { ResourceProcessingV2Workflow, ResourceTranslationV2Workflow, SearchIndexGeneration5RebuildWorkflow };

async function runFiveMinuteCycle(env: CoreEnv): Promise<void> {
	const results = await Promise.allSettled([handleRSSCron(env), reconcilePendingResourceProcessing(env)]);
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
			this.ctx.waitUntil(handleTwitterCron(this.env));
		}
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue canonical resources for the enrichment workflow after app-side persistence. */
	async enqueueResourceProcessing(resourceId: string) {
		if (await isResourceEnrichmentComplete(this.env, resourceId)) return undefined;
		return enqueueProcessing(this.env, resourceId);
	}

	/** Reacquire a URL-backed resource through the enrichment workflow. */
	async resyncResource(resourceId: string) {
		await assertResourceProcessable(this.env, resourceId);
		return enqueueResourceResync(this.env, resourceId);
	}

	/** Hybrid AI Search retrieval for the canonical corpus search tool. */
	searchResources(input: ResourceSearchInput) {
		return searchCorpusResources(this.env, input);
	}

	/** Hybrid rank search for app-side feed/context lookup. */
	searchResourceRanks(input: ResourceSearchInput) {
		return searchCorpusResourceRanks(this.env, input);
	}

	/** Related resource ids for app-side recommendations. */
	relatedResourceIds(input: RelatedResourceSearchInput) {
		return relatedCorpusResourceIds(this.env, input);
	}

	/** Read workflow status for app-side polling. */
	async getWorkflowStatus(instanceId: string) {
		const instance = await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.get(instanceId);
		return instance.status();
	}

	/** Bounded, revision-pinned product resource chunk. */
	readCorpusResource(input: KnowledgeResourceReadInput) {
		return readCorpusResource(this.env, input);
	}

	/** Authoritative resource references and titles for product context. */
	resolveCorpusResources(input: KnowledgeResolveResourcesInput) {
		return resolveCorpusResources(this.env, input);
	}

	/** Resolve an explicitly requested feed/account/channel monitor into a source row candidate (#237). */
	resolveMonitoredSource(input: ResolveMonitoredSourceInput) {
		return resolveMonitoredSource(this.env, input);
	}
}
