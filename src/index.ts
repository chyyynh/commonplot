import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { CONTENT_TRANSLATION_LANGS } from './contracts/languages';
import { IMPORT_WORKFLOW_PREFIX, ResourceImportDispatchSchema } from './contracts/processing-target';
import { resolveResourceUrl, ResourceUrlSchema } from './contracts/resource-url';
import type {} from './env';
import { handleRSSCron } from './monitors/rss';
import { handleTwitterCron } from './monitors/twitter';
import { nearCorpusResources, nearInterest, type PublicResourceSearchInput, searchPublicResources } from './search/search-index';
import { consumeSearchSyncBatch } from './search/sync-consumer';
import { withCoreDb } from './store/db';
import { findResourcesByUrls } from './store/resources';
import { enqueueDueDerivations } from './workflows/derivation';
import { admitRequests, reconcileRequests } from './workflows/requests';
import { contentTranslationStatus, importProgress, requestContentTranslation } from './workflows/translation';

export { ZoteroSdt } from './services/zotero-sdt-service';
export { ResourceTranslationV2Workflow } from './workflows/translation';
export { CorpusVectorsBackfillWorkflow } from './search/vectors-backfill-workflow';
export { ResourceProcessingV2Workflow } from './workflows/processing';
export { ResourceDerivationWorkflow } from './workflows/derivation';
export { PageFetcher } from './services/page-fetcher';
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
				withCoreDb(this.env, (db) => Promise.allSettled([handleRSSCron(db), enqueueDueDerivations(db), reconcileRequests(db)])),
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
	 * Records a user's import as a request named by the handle's UUID and starts its acquisition; dispatching it again
	 * records nothing new. Web dispatches only committed uploads, and the Workflow rechecks ownership and the latest
	 * attempt before provider execution. Web reads the import's progress from the request and saves its Resource.
	 */
	async dispatchResourceImport(input: z.input<typeof ResourceImportDispatchSchema>): Promise<void> {
		const { workflowId, userId, notebookId, label, payload } = ResourceImportDispatchSchema.parse(input);
		const id = workflowId.slice(IMPORT_WORKFLOW_PREFIX.length);
		await withCoreDb(this.env, (db) => admitRequests(db, [{ requester: 'user', id, userId, notebookId, label, target: payload }]));
	}

	/** What Web's ready imports show for their cards and content translations, by Resource. */
	async importTranslations(input: { resourceId: string; textHash: string }[]) {
		const items = z
			.array(z.strictObject({ resourceId: z.uuid(), textHash: z.string().min(1) }))
			.max(50)
			.parse(input);
		return withCoreDb(this.env, async (db) =>
			Object.fromEntries(
				await Promise.all(
					items.map(async ({ resourceId, textHash }) => [resourceId, (await importProgress(db, resourceId, textHash)) ?? null] as const),
				),
			),
		);
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
		return requestContentTranslation(this.env, id, z.enum(CONTENT_TRANSLATION_LANGS).parse(lang));
	}

	resourceTranslationStatus(resourceId: string, lang: string) {
		const id = z.uuid().parse(resourceId);
		return contentTranslationStatus(this.env, id, z.enum(CONTENT_TRANSLATION_LANGS).parse(lang));
	}

	/** Ranked corpus candidates with matched passages; the app Worker authoritatively filters and hydrates them. */
	searchCorpus(input: PublicResourceSearchInput) {
		return searchPublicResources(this.env, input);
	}

	/** The corpus nearest a Resource in meaning, each with its similarity; the app Worker filters and ranks them. */
	nearCorpusResources(resourceId: string) {
		return nearCorpusResources(this.env, z.uuid().parse(resourceId));
	}

	/** Recent corpus publications nearest a reader's weighted items, each with its similarity; Web owns whose items they are. */
	nearInterest(input: Parameters<typeof nearInterest>[1]) {
		return nearInterest(this.env, input);
	}
}
