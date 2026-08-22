import type { CoreDb } from '@db/connection';
import { inArray, sql } from 'drizzle-orm';

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	avatarUrl: string | null;
	scrapedAt: Date | null;
	createdAt: Date;
};

/**
 * Enabled sources due to be polled. Platform is the routing policy: Twitter
 * has its provider monitor, while RSS, LessWrong, and YouTube share the feed
 * monitor. YouTube's slower cadence is intrinsic provider policy, not row data.
 */
export async function loadMonitoredSources(db: CoreDb, monitor: 'feed' | 'twitter'): Promise<MonitoredSource[]> {
	const platformFilter =
		monitor === 'twitter'
			? sql`platform = 'twitter'`
			: sql`platform IN ('rss', 'lesswrong', 'youtube')
					AND (platform <> 'youtube' OR scraped_at IS NULL OR scraped_at < NOW() - INTERVAL '30 minutes')`;
	const result = await db.execute<MonitoredSource>(sql`
		SELECT
			id::text AS id,
			name,
			handle,
			avatar_url AS "avatarUrl",
			scraped_at AS "scrapedAt",
			created_at AS "createdAt"
		FROM sources
		WHERE enabled = true
		  AND ${platformFilter}
	`);
	return result.rows;
}

export async function markSourcesScraped(db: CoreDb, sourceIds: string[], scrapedAt: Date = new Date()): Promise<number> {
	if (!sourceIds.length) return 0;
	if (!Number.isFinite(scrapedAt.getTime())) throw new Error('Source watermark is invalid');
	// Success also settles the #237 lifecycle: pending/failed rows become
	// active and the scrape_state failure counters reset. The predicate keeps
	// overlapping cron invocations from regressing a newer watermark.
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

const PENDING_VALIDATION_FAILURE_LIMIT = 3;

// Never throws: failure bookkeeping must not break cron error isolation.
// Single statement: bumps the counter and flips a pending source to failed
// (and off) once it exhausts validation attempts; active sources ride out
// transient outages — only the counters move.
export async function recordSourceFailure(db: CoreDb, sourceId: string, error: unknown): Promise<void> {
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
					WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= ${PENDING_VALIDATION_FAILURE_LIMIT}
					THEN 'failed' ELSE status END,
				enabled = CASE
					WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= ${PENDING_VALIDATION_FAILURE_LIMIT}
					THEN false ELSE enabled END,
				updated_at = ${failedAt}
			WHERE id = ${sourceId}
		`);
	} catch (recordError) {
		console.error({
			tag: 'SOURCES',
			msg: 'Failed to record source failure',
			sourceId,
			error: recordError instanceof Error ? recordError.message : String(recordError),
		});
	}
}
