import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { resourceUrlTitle } from './adapters/acquire';
import { ResourceImportDispatchSchema } from './contracts/processing-target';
import { resolveResourceUrl, ResourceUrlSchema } from './contracts/resource-url';
import type {} from './env';
import { coreExports } from './exports.ts';
import { handleRSSCron } from './monitors/rss';
import { handleTwitterCron } from './monitors/twitter';
import {
	type PublicResourceSearchInput,
	type RelatedResourceSearchInput,
	searchPublicResourceIds,
	searchPublicResourcePassages,
	searchRelatedResources,
} from './search/search-index';
import { consumeSearchSyncBatch } from './search/sync-consumer';
import { withCoreDb } from './store/db';
import { findResourcesByUrls } from './store/resources';
import { resourceImportExecution } from './workflows/processing';
import { contentTranslationStatus, enqueueMissingTranslations, requestContentTranslation } from './workflows/translation';

export { ZoteroSdt } from './services/zotero-sdt-container';
export { ResourceTranslationV2Workflow } from './workflows/translation';
export { SearchIndexRebuildWorkflow } from './search/rebuild-workflow';
export { ResourceVectorBackfillWorkflow } from './search/vector-backfill-workflow';
export { ResourceProcessingV2Workflow } from './workflows/processing';
export { ResourceEntityBackfillWorkflow } from './workflows/entities';
export { YouTubeCaptionFetcher } from './services/youtube-captions';

const PREVIEW_TIMEOUT_MS = 6_000;

export default class CoreWorker extends WorkerEntrypoint<CoreEnv> {
	override fetch(_request: Request): Response {
		return new Response('Not found', { status: 404 });
	}

	override scheduled(event: ScheduledController): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

		// YouTube channels ride the feed monitor through their Atom URLs; Core
		// derives their slower polling cadence from the canonical feed URL.
		if (event.cron === '*/5 * * * *') {
			this.ctx.waitUntil(withCoreDb(this.env, (db) => Promise.allSettled([handleRSSCron(db), enqueueMissingTranslations(db)])));
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
	 * A link's title before anyone saves it: read-only, nothing is persisted.
	 * A slow or blocked site yields null and the caller shows the bare link.
	 */
	async previewResourceTitle(url: string): Promise<string | null> {
		const parsed = ResourceUrlSchema.max(2_048).parse(url);
		try {
			return await Promise.race([
				resourceUrlTitle(this.env, parsed),
				new Promise<null>((resolve) => setTimeout(resolve, PREVIEW_TIMEOUT_MS, null)),
			]);
		} catch (error) {
			console.warn({ tag: 'PREVIEW', msg: 'Link title unavailable', url: parsed, error: String(error) });
			return null;
		}
	}

	/** Durable admission outbox: the caller persists this immutable ID and payload first. */
	async dispatchResourceImport(input: z.input<typeof ResourceImportDispatchSchema>): Promise<void> {
		const parsed = ResourceImportDispatchSchema.parse(input);
		// The admission DO waits for committed ownership. The Workflow rechecks
		// ownership and the latest attempt before provider execution, after any
		// queueing delay; another callback here cannot replace that execution gate.
		await coreExports.ResourceProcessingV2Workflow.createBatch([
			{ id: parsed.workflowId, params: parsed.payload, retention: { successRetention: '7 days', errorRetention: '7 days' } },
		]);
	}

	/** Each Web import's progress, read from its own Workflow; Web asks only while one is unsettled. */
	async resourceImportStatus(workflowIds: string[]) {
		const ids = z.array(ResourceImportDispatchSchema.shape.workflowId).max(50).parse(workflowIds);
		return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await resourceImportExecution(id)] as const)));
	}

	/**
	 * Reacquire a URL-backed resource through the enrichment workflow. A much shorter result keeps
	 * the stored original unless `force` is set, e.g. when the source itself was cut down.
	 */
	async resyncResource(resourceId: string, force?: boolean) {
		const id = z.uuid().parse(resourceId);
		const forced = z.boolean().optional().parse(force);
		const instance = await coreExports.ResourceProcessingV2Workflow.create({
			id: `resource-resync-v3-${id}-${crypto.randomUUID()}`,
			params: { kind: 'reacquire', ...(forced ? { force: true } : {}), resourceId: id },
		});
		return instance.id;
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

	/** Resource-level semantic neighbors; the app Worker authoritatively filters and hydrates them. */
	searchRelatedResources(input: RelatedResourceSearchInput) {
		return searchRelatedResources(this.env, input);
	}
}
