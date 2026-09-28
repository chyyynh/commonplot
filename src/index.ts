import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { PaidPdfFallbackGrantSchema, type PaidPdfFallbackGrant } from './contracts/pdf-policy';
import { ResourceImportDispatchSchema } from './contracts/processing-target';
import { resolveResourceUrl, ResourceUrlSchema } from './contracts/resource-url';
import type {} from './env';
import { handleRSSCron } from './monitors/rss';
import { handleTwitterCron } from './monitors/twitter';
import {
	loadCorpusDocuments,
	type PublicResourceSearchInput,
	type RelatedResourceSearchInput,
	searchPublicResourceIds,
	searchRelatedResourceIds,
	syncCorpusItem,
} from './search/search-index';
import { withCoreDb } from './store/db';
import { findResourcesByUrls } from './store/resources';
import { enqueueMissingTranslations } from './workflows/translation';

export { ContainerProxy } from '@cloudflare/containers';
export { ZoteroSdtContainer } from './services/zotero-sdt-container';
export { ResourceTranslationV2Workflow } from './workflows/translation';
export { SearchIndexRebuildWorkflow } from './search/rebuild-workflow';
export { ResourceProcessingV2Workflow } from './workflows/processing';
export { YouTubeCaptionFetcher } from './services/youtube-captions';

// Not strict: messages queued by earlier revisions also carried a progress task id.
const ResourceSearchSyncMessageSchema = z.object({
	resourceId: z.uuid().toLowerCase(),
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
			this.ctx.waitUntil(
				withCoreDb(this.env, (db) => Promise.allSettled([handleRSSCron(this.env, db), enqueueMissingTranslations(this.env, db)])),
			);
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
		try {
			await withCoreDb(this.env, async (db) => {
				const documents = await loadCorpusDocuments(db, [...pending.keys()]);
				const documentsById = new Map(documents.map((document) => [document.id, document]));
				for (const [resourceId, messages] of pending) {
					try {
						const document = documentsById.get(resourceId);
						await syncCorpusItem(this.env, resourceId, document);
						// Another consumer may have uploaded a newer snapshot first. Retry from
						// Postgres instead of acknowledging a stale upload or deletion.
						const [current] = await loadCorpusDocuments(db, [resourceId]);
						if (JSON.stringify(current) !== JSON.stringify(document)) throw new Error('Resource changed during search sync');
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
			});
		} catch (error) {
			// Only the batch load can throw here; each resource settles its own messages.
			console.error({ tag: 'AI_SEARCH', msg: 'Resource sync batch could not be loaded', error });
			for (const messages of pending.values()) {
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
		return withCoreDb(this.env, (db) =>
			findResourcesByUrls(
				db,
				parsed.map((url) => resolveResourceUrl(url)!),
			),
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

	/**
	 * Reacquire a URL-backed resource through the enrichment workflow. A much shorter result keeps
	 * the stored original unless `force` is set, e.g. when the source itself was cut down.
	 */
	async resyncResource(resourceId: string, paidPdfFallback?: PaidPdfFallbackGrant, force?: boolean) {
		const id = z.uuid().parse(resourceId);
		const grant = PaidPdfFallbackGrantSchema.optional().parse(paidPdfFallback);
		const forced = z.boolean().optional().parse(force);
		const instance = await this.env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
			id: `resource-resync-v3-${id}-${crypto.randomUUID()}`,
			params: { kind: 'reacquire', ...(grant ? { paidPdfFallback: grant } : {}), ...(forced ? { force: true } : {}), resourceId: id },
		});
		return instance.id;
	}

	/** Ranked AI Search candidates; the app Worker authoritatively filters and hydrates them. */
	searchPublicResourceIds(input: PublicResourceSearchInput) {
		return searchPublicResourceIds(this.env, input);
	}

	/** Resource-level semantic neighbors; the app Worker authoritatively filters and hydrates them. */
	searchRelatedResourceIds(input: RelatedResourceSearchInput) {
		return searchRelatedResourceIds(this.env, input);
	}
}
