import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type {} from './env';
import { ResourceImportDispatchSchema } from './ingest/admission';
import { PaidPdfFallbackGrantSchema, type PaidPdfFallbackGrant } from './ingest/platforms/pdf-policy';
import { resolveResourceUrl, ResourceUrlSchema } from './ingest/platforms/resource-url';
import { handleRSSCron } from './ingest/platforms/rss';
import { handleTwitterCron } from './ingest/platforms/twitter';
import { findResourcesByUrls } from './ingest/resource-persistence';
import {
	loadCorpusDocuments,
	type PublicResourceSearchInput,
	type RelatedResourceSearchInput,
	searchPublicResourceIds,
	searchRelatedResourceIds,
	syncCorpusItem,
} from './search-index';
import { connectCoreDb } from './shared/db';

export { ContainerProxy } from '@cloudflare/containers';
export { GrobidContainer, ZoteroSdtContainer } from './ingest/pdf-containers';
export { ResourceTranslationV2Workflow } from './ingest/translation-workflow';
export { SearchIndexRebuildWorkflow } from './operations/search-index-rebuild';
export { ResourceProcessingV2Workflow } from './ingest/workflow';

const ResourceSearchSyncMessageSchema = z.strictObject({
	resourceId: z.uuid().toLowerCase(),
	taskId: z.string().min(1).max(150).optional(),
});

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
		const pending = new Map<string, { messages: Message<unknown>[]; taskIds: Set<string> }>();
		for (const message of batch.messages) {
			const input = ResourceSearchSyncMessageSchema.safeParse(message.body);
			if (!input.success) {
				console.warn({ tag: 'AI_SEARCH', msg: 'Invalid resource sync message', message_id: message.id });
				message.ack();
				continue;
			}
			const group = pending.get(input.data.resourceId) ?? { messages: [], taskIds: new Set<string>() };
			group.messages.push(message);
			if (input.data.taskId) group.taskIds.add(input.data.taskId);
			pending.set(input.data.resourceId, group);
		}
		if (!pending.size) return;
		let documents: Awaited<ReturnType<typeof loadCorpusDocuments>>;
		try {
			documents = await loadCorpusDocuments(await connectCoreDb(this.env), [...pending.keys()]);
		} catch (error) {
			console.error({ tag: 'AI_SEARCH', msg: 'Resource sync batch could not be loaded', error });
			for (const { messages } of pending.values()) {
				for (const message of messages) message.retry();
			}
			return;
		}
		const documentsById = new Map(documents.map((document) => [document.id, document]));
		for (const [resourceId, { messages, taskIds }] of pending) {
			try {
				await syncCorpusItem(this.env, resourceId, documentsById.get(resourceId));
				for (const taskId of taskIds) {
					await this.env.APP.reportResourceProgress({
						taskId,
						stage: 'indexing',
						status: documentsById.has(resourceId) ? 'complete' : 'skipped',
						resourceId,
					});
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
				for (const message of messages) message.retry();
			}
		}
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Batch identity lookup only: acquisition stays durable and user saves remain app-owned. */
	async resolveResourceUrls(urls: string[]) {
		const parsed = z.array(ResourceUrlSchema.max(2_048)).max(20).parse(urls);
		if (!parsed.length) return [];
		return findResourcesByUrls(
			await connectCoreDb(this.env),
			parsed.map((url) => resolveResourceUrl(url)!),
		);
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
	async resyncResource(resourceId: string, paidPdfFallback?: PaidPdfFallbackGrant) {
		const id = z.uuid().parse(resourceId);
		const grant = PaidPdfFallbackGrantSchema.optional().parse(paidPdfFallback);
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
