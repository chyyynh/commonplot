import { type CoreDb, withCoreDb } from '@db/client';
import { sources } from '@db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	scrapedAt: Date | null;
	createdAt: Date;
};

/**
 * Enabled sources due to be polled. Twitter has its provider monitor; RSS,
 * LessWrong, and YouTube handles are feeds and share the feed monitor.
 *
 * A null pollIntervalMinutes means every firing, so sources that never set one
 * behave exactly as before; setting it lets one monitor carry feeds whose
 * publishers update at very different rates.
 */
export async function loadMonitoredSources(env: CoreEnv, monitor: 'feed' | 'platform'): Promise<MonitoredSource[]> {
	return withCoreDb(env, async (db: CoreDb) =>
		db
			.select({
				id: sources.id,
				name: sources.name,
				handle: sources.handle,
				scrapedAt: sources.scrapedAt,
				createdAt: sources.createdAt,
			})
			.from(sources)
			.where(
				and(
					eq(sources.monitoringEnabled, true),
					monitor === 'platform' ? eq(sources.platform, 'twitter') : inArray(sources.platform, ['rss', 'lesswrong', 'youtube']),
					sql`(
						${sources.pollIntervalMinutes} IS NULL
						OR ${sources.scrapedAt} IS NULL
						OR ${sources.scrapedAt} < NOW() - (INTERVAL '1 minute' * ${sources.pollIntervalMinutes})
					)`,
				),
			),
	);
}

export async function markSourcesScraped(env: CoreEnv, sourceIds: string[], scrapedAt: Date = new Date()): Promise<void> {
	if (!sourceIds.length) return;
	await withCoreDb(env, async (db) => {
		// Success also settles the #237 lifecycle: pending/failed rows become
		// active and the scrape_state failure counters reset.
		await db
			.update(sources)
			.set({ scrapedAt, updatedAt: scrapedAt, status: 'active', scrapeState: null })
			.where(inArray(sources.id, sourceIds));
	});
}

const PENDING_VALIDATION_FAILURE_LIMIT = 3;

// Never throws: failure bookkeeping must not break cron error isolation.
// Single statement: bumps the counter and flips a pending source to failed
// (and off) once it exhausts validation attempts; active sources ride out
// transient outages — only the counters move.
export async function recordSourceFailure(env: CoreEnv, sourceId: string, error: unknown): Promise<void> {
	const failedAt = new Date();
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
	try {
		await withCoreDb(env, async (db) => {
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
		});
	} catch (recordError) {
		console.error({
			tag: 'SOURCES',
			msg: 'Failed to record source failure',
			sourceId,
			error: recordError instanceof Error ? recordError.message : String(recordError),
		});
	}
}
