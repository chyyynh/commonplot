import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export async function markSourcesScraped(db: NodePgDatabase, sourceIds: string[], scrapedAt: Date = new Date()): Promise<number> {
	if (!sourceIds.length) return 0;
	if (!Number.isFinite(scrapedAt.getTime())) throw new Error('Source watermark is invalid');
	const updated = await db.execute(sql`
		UPDATE sources
		SET scraped_at = ${scrapedAt},
		    updated_at = NOW(),
		    status = 'active',
		    scrape_state = NULL
		WHERE ${inArray(sql`id`, sourceIds)}
		  AND (scraped_at IS NULL OR scraped_at <= ${scrapedAt})
		RETURNING id
	`);
	return updated.rows.length;
}

// Pending sources stop after three validation failures. Active sources keep
// monitoring through transient provider failures.
export async function recordSourceFailure(db: NodePgDatabase, sourceId: string, error: unknown): Promise<void> {
	const failedAt = new Date();
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
	try {
		await db.execute(sql`
			UPDATE sources SET
				scrape_state = jsonb_build_object(
					'consecutiveFailures', COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1,
					'lastError', ${message}::text,
					'lastFailureAt', ${failedAt.toISOString()}::text
				),
				status = CASE
					WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= 3
					THEN 'failed' ELSE status END,
				enabled = CASE
					WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= 3
					THEN false ELSE enabled END,
				updated_at = ${failedAt}
			WHERE id = ${sourceId}
		`);
	} catch (recordError) {
		// Failure bookkeeping must not break per-source cron isolation.
		console.error({
			tag: 'SOURCES',
			msg: 'Failed to record source failure',
			sourceId,
			error: recordError instanceof Error ? recordError.message : String(recordError),
		});
	}
}
