import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { IMPORT_WORKFLOW_PREFIX, ImportWorkflowIdSchema, ResourceImportDispatchSchema } from './contracts/processing-target';
import { resolveResourceUrl, ResourceUrlSchema } from './contracts/resource-url';
import type {} from './env';
import { handleRSSCron } from './monitors/rss';
import { handleTwitterCron } from './monitors/twitter';
import { type PublicResourceSearchInput, searchPublicResourceIds, searchPublicResourcePassages } from './search/search-index';
import { consumeSearchSyncBatch } from './search/sync-consumer';
import { withCoreDb } from './store/db';
import { findResourcesByUrls } from './store/resources';
import { enqueueDueDerivations } from './workflows/derivation';
import { admitRequests, reconcileRequests, resourceImportExecutions } from './workflows/requests';
import { contentTranslationStatus, requestContentTranslation } from './workflows/translation';

export { ZoteroSdt } from './services/zotero-sdt-service';
export { ResourceTranslationV2Workflow } from './workflows/translation';
export { SearchIndexRebuildWorkflow } from './search/rebuild-workflow';
export { ResourceProcessingV2Workflow } from './workflows/processing';
export { ResourceDerivationWorkflow } from './workflows/derivation';
export { YouTubeCaptionFetcher } from './services/youtube-captions';

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
				withCoreDb(this.env, (db) => Promise.allSettled([handleRSSCron(db), enqueueDueDerivations(db), reconcileRequests(this.env, db)])),
			);
		} else if (event.cron === '0 */6 * * *') {
			this.ctx.waitUntil(handleTwitterCron(this.env, new Date(event.scheduledTime)));
		}
	}

	override queue(batch: MessageBatch<unknown>): Promise<void> {
		return consumeSearchSyncBatch(this.env, batch);
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

	/**
	 * Durable admission outbox: the caller persists this immutable handle and payload first, and its UUID becomes the
	 * request's id, so dispatching it again records nothing new. An upload's owner is read from its stored object.
	 */
	async dispatchResourceImport(input: z.input<typeof ResourceImportDispatchSchema>): Promise<void> {
		const { workflowId, payload } = ResourceImportDispatchSchema.parse(input);
		const id = workflowId.slice(IMPORT_WORKFLOW_PREFIX.length);
		// The admission DO waits for committed ownership. The Workflow rechecks ownership and the latest attempt
		// before provider execution, after any queueing delay.
		await withCoreDb(this.env, (db) =>
			admitRequests(db, [
				payload.kind === 'draft'
					? {
							requester: 'user',
							id,
							userId: payload.saveTarget.userId,
							notebookId: payload.saveTarget.notebookId,
							target: { kind: 'draft', url: payload.url },
						}
					: { requester: 'user', id, userId: null, notebookId: null, target: payload },
			]),
		);
	}

	/** Each Web import's progress, read from its request; Web asks only while one is unsettled. */
	async resourceImportStatus(workflowIds: string[]) {
		const ids = z.array(ImportWorkflowIdSchema).max(50).parse(workflowIds);
		return withCoreDb(this.env, (db) => resourceImportExecutions(db, ids));
	}

	/**
	 * Reacquire a URL-backed resource through the enrichment workflow. A much shorter result keeps
	 * the stored original unless `force` is set, e.g. when the source itself was cut down. A resync
	 * already in flight for the Resource is joined rather than repeated.
	 */
	async resyncResource(resourceId: string, force?: boolean) {
		const id = z.uuid().parse(resourceId);
		const forced = z.boolean().optional().parse(force);
		const leads = await withCoreDb(this.env, (db) =>
			admitRequests(db, [{ requester: 'resync', target: { kind: 'reacquire', resourceId: id, ...(forced ? { force: true } : {}) } }]),
		);
		return leads[0]?.workflowId ?? null;
	}

	/** A reader's full translation into `lang`. The app Worker checks entitlement and bills an admitted request. */
	requestResourceTranslation(resourceId: string, lang: string) {
		const id = z.uuid().parse(resourceId);
		z.literal('zh-Hant').parse(lang);
		return requestContentTranslation(this.env, id);
	}

	resourceTranslationStatus(resourceId: string, lang: string) {
		const id = z.uuid().parse(resourceId);
		z.literal('zh-Hant').parse(lang);
		return contentTranslationStatus(this.env, id);
	}

	/** Ranked AI Search candidates; the app Worker authoritatively filters and hydrates them. */
	searchPublicResourceIds(input: PublicResourceSearchInput) {
		return searchPublicResourceIds(this.env, input);
	}

	/** Ranked candidates with matched passages; the app Worker filters and hydrates them. */
	searchPublicResourcePassages(input: PublicResourceSearchInput) {
		return searchPublicResourcePassages(this.env, input);
	}
}
