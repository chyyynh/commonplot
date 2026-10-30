import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MonitorKind } from '../contracts/monitors';

export type DueMonitor = Readonly<{
	id: string;
	kind: MonitorKind;
	locator: string;
	name: string;
	state: Record<string, unknown>;
	createdAt: string;
}>;

/** How far apart a monitor's checks may be, in seconds. */
export type MonitorInterval = Readonly<{ min: number; max: number }>;

/** A claimed monitor is not claimed again this long, so a check that died with its Worker runs again after it. */
const MONITOR_LEASE = sql`interval '10 minutes'`;
const MAX_BACKOFF_SECONDS = 24 * 60 * 60;

/** Active monitors whose check is due, oldest due first, leased so overlapping crons check each once. */
export async function claimDueMonitors(db: NodePgDatabase, limit: number) {
	const { rows } = await db.execute<DueMonitor>(sql`
		UPDATE monitors monitor SET next_check_at = NOW() + ${MONITOR_LEASE}
		FROM (
			SELECT id FROM monitors
			WHERE status = 'active' AND next_check_at <= NOW()
			ORDER BY next_check_at
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		) due
		WHERE monitor.id = due.id
		RETURNING monitor.id::text, monitor.kind, monitor.locator, monitor.name, monitor.state, monitor.created_at AS "createdAt"
	`);
	return rows;
}

/**
 * A quarter of the time between the entries the monitor listed in the last week and Core kept, within the kind's bounds:
 * a monitor is checked about four times per kept entry, and one whose entries were all rejected waits the longest.
 */
function cadenceSql({ min, max }: MonitorInterval) {
	return sql`LEAST(GREATEST(
		604800.0 / 4 / GREATEST((
			SELECT count(*) FROM resource_requests listed
			WHERE listed.requester = 'monitor' AND listed.monitor_id = monitors.id AND listed.status <> 'rejected'
			  AND listed.created_at > NOW() - interval '7 days'
		), 1),
		${min}::float8), ${max}::float8)`;
}

/**
 * Records a check and schedules the next one. A success stores the adapter's new state and clears the failures; a
 * failure keeps the old state and waits the cadence doubled per failure in a row, up to a day, so a source that recovers
 * is read again within a day.
 */
export async function recordMonitorCheck(
	db: NodePgDatabase,
	monitorId: string,
	interval: MonitorInterval,
	result: Readonly<{ state: Record<string, unknown> }> | Readonly<{ error: string }>,
) {
	const { rows } = await db.execute<{ failures: number; nextCheckAt: string }>(
		'state' in result
			? sql`
				UPDATE monitors SET state = ${JSON.stringify(result.state)}::jsonb, failures = 0, last_error = NULL,
				       checked_at = NOW(), updated_at = NOW(), next_check_at = NOW() + make_interval(secs => ${cadenceSql(interval)})
				WHERE id = ${monitorId}::uuid
				RETURNING failures, next_check_at AS "nextCheckAt"
			`
			: sql`
				UPDATE monitors SET failures = failures + 1, last_error = LEFT(${result.error}, 500),
				       checked_at = NOW(), updated_at = NOW(),
				       next_check_at = NOW() + make_interval(secs => LEAST(${cadenceSql(interval)} * power(2, failures), ${MAX_BACKOFF_SECONDS}::float8))
				WHERE id = ${monitorId}::uuid
				RETURNING failures, next_check_at AS "nextCheckAt"
			`,
	);
	return rows[0];
}
