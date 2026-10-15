import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { withCoreDb } from '../store/db';
import { listMissingEnglishMetadata } from '../store/translations';
import { enqueueResourceTranslation } from '../workflows/translation';
import { SEARCHABLE_CORPUS_RESOURCE_SQL } from './search-index';

/**
 * `translate` admits an English title and summary for every corpus Resource that lacks one; run it first, so `embed`
 * then queues every searchable Resource for its vector once, already in English.
 */
type ResourceVectorBackfillPayload = { phase: 'translate' | 'embed' };

// Kept at the missing-translation sweep's size, a minute apart, so the backfill never crowds new imports out of the
// provider's per-minute window.
const TRANSLATE_PAGE_SIZE = 25;
const TRANSLATE_PAGE_INTERVAL = '1 minute';
const EMBED_PAGE_SIZE = 100;
const STEP_OPTIONS = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' } as const;

export class ResourceVectorBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceVectorBackfillPayload> {
	async run(event: WorkflowEvent<ResourceVectorBackfillPayload>, step: WorkflowStep) {
		const { phase } = event.payload;
		if (phase === 'translate') return { phase, ...(await this.translate(step)) };
		if (phase === 'embed') return { phase, ...(await this.embed(step)) };
		throw new Error(`Invalid vector backfill phase: ${String(phase)}`);
	}

	private async translate(step: WorkflowStep) {
		let cursor: string | null = null;
		let admitted = 0;
		let failed = 0;
		for (let page = 0; ; page++) {
			const result = await step.do(`admit-english-page-${page}`, STEP_OPTIONS, () =>
				withCoreDb(this.env, async (db) => {
					const rows = await listMissingEnglishMetadata(db, cursor, TRANSLATE_PAGE_SIZE);
					const outcomes = await Promise.allSettled(rows.map((row) => enqueueResourceTranslation(row, 'metadata', false)));
					return {
						cursor: rows.at(-1)?.id ?? null,
						admitted: outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value?.admitted).length,
						failed: outcomes.filter((outcome) => outcome.status === 'rejected').length,
					};
				}),
			);
			admitted += result.admitted;
			failed += result.failed;
			if (!result.cursor) return { admitted, failed, pages: page + 1 };
			cursor = result.cursor;
			await step.sleep(`wait-english-page-${page}`, TRANSLATE_PAGE_INTERVAL);
		}
	}

	/** The sync queue embeds and upserts; it reloads each Resource, retries, and wins any race with live writes. */
	private async embed(step: WorkflowStep) {
		let cursor: string | null = null;
		let enqueued = 0;
		for (let page = 0; ; page++) {
			const result = await step.do(`enqueue-vector-page-${page}`, STEP_OPTIONS, () =>
				withCoreDb(this.env, async (db) => {
					const { rows } = await db.execute<{ id: string }>(sql`
						SELECT r.id::text
						FROM resources r
						WHERE ${SEARCHABLE_CORPUS_RESOURCE_SQL}
						  AND (${cursor}::uuid IS NULL OR r.id > ${cursor}::uuid)
						ORDER BY r.id
						LIMIT ${EMBED_PAGE_SIZE}
					`);
					if (rows.length)
						await this.env.RESOURCE_SEARCH_SYNC_QUEUE.sendBatch(rows.map(({ id }) => ({ body: { resourceId: id, only: 'vectors' } })));
					return { cursor: rows.at(-1)?.id ?? null, enqueued: rows.length };
				}),
			);
			enqueued += result.enqueued;
			if (!result.cursor) return { enqueued, pages: page + 1 };
			cursor = result.cursor;
		}
	}
}
