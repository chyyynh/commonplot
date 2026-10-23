import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { withCoreDb } from '../store/db';
import { syncCorpusVectors } from './corpus-vectors';
import { loadCorpusDocuments, SEARCHABLE_CORPUS_RESOURCE_SQL } from './search-index';

const BACKFILL_PAGE_SIZE = 50;
/** An optional UUID range `(after, through]`, so several instances can split the corpus. */
type BackfillParams = { after?: string; through?: string };
const PAGE_STEP_OPTIONS = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' } as const;

/**
 * Writes every searchable corpus Resource's vectors in UUID order, a page per step. A Resource that changed
 * while its page was written goes to the sync queue, whose consumer writes its current snapshot.
 */
export class CorpusVectorsBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, BackfillParams> {
	async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep) {
		const through = event.payload.through ?? null;
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
							WHERE ${SEARCHABLE_CORPUS_RESOURCE_SQL}
							  AND (${cursor}::uuid IS NULL OR r.id > ${cursor}::uuid)
							  AND (${through}::uuid IS NULL OR r.id <= ${through}::uuid)
							ORDER BY r.id
							LIMIT ${BACKFILL_PAGE_SIZE}
						`);
						const ids = rows.map((row) => row.id);
						const documents = await loadCorpusDocuments(db, ids);
						await syncCorpusVectors(this.env, documents, []);
						const current = new Map((await loadCorpusDocuments(db, ids)).map((document) => [document.id, document]));
						const changed = documents.filter((document) => JSON.stringify(current.get(document.id)) !== JSON.stringify(document));
						if (changed.length)
							await this.env.RESOURCE_SEARCH_SYNC_QUEUE.sendBatch(changed.map((document) => ({ body: { resourceId: document.id } })));
						return { cursor: ids.at(-1) ?? null, written: documents.length, requeued: changed.length };
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
