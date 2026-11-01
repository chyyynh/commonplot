import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { withCoreDb } from '../store/db';
import { SEARCHABLE_RESOURCE_SQL, syncSearchDocuments } from './search-index';

const BACKFILL_PAGE_SIZE = 50;
/** An optional UUID range `(after, through]`, so several instances can split the corpus, and the scope to write. */
type BackfillParams = { after?: string; through?: string; scope?: 'corpus' | 'private' };
const PAGE_STEP_OPTIONS = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' } as const;

/**
 * Writes every searchable Resource's vectors of one scope (corpus by default) in UUID order, a page per step. A Resource that changed
 * while its page was written goes to the sync queue, whose consumer writes its current snapshot.
 */
export class CorpusVectorsBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, BackfillParams> {
	async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep) {
		const through = event.payload.through ?? null;
		const scope = event.payload.scope ?? 'corpus';
		let cursor: string | null = event.payload.after ?? null;
		let written = 0;
		let requeued = 0;
		let pages = 0;
		while (true) {
			const page: { cursor: string | null; written: number; requeued: number } = await step.do(
				`backfill-page-${pages}`,
				PAGE_STEP_OPTIONS,
				() =>
					withCoreDb(this.env, async (db) => {
						const { rows } = await db.execute<{ id: string }>(sql`
							SELECT r.id::text FROM resources r
							WHERE r.scope = ${scope} AND ${SEARCHABLE_RESOURCE_SQL}
							  AND (${cursor}::uuid IS NULL OR r.id > ${cursor}::uuid)
							  AND (${through}::uuid IS NULL OR r.id <= ${through}::uuid)
							ORDER BY r.id
							LIMIT ${BACKFILL_PAGE_SIZE}
						`);
						const ids = rows.map((row) => row.id);
						const { written, changed } = await syncSearchDocuments(this.env, db, ids);
						if (changed.length)
							await this.env.RESOURCE_SEARCH_SYNC_QUEUE.sendBatch(changed.map((resourceId) => ({ body: { resourceId } })));
						return { cursor: ids.at(-1) ?? null, written, requeued: changed.length };
					}),
			);
			if (!page.cursor) break;
			cursor = page.cursor;
			written += page.written;
			requeued += page.requeued;
			pages++;
		}
		return { pages, written, requeued };
	}
}
