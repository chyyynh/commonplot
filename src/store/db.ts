import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

/**
 * One short-lived pool per unit of work, ended even when the work throws. A pool, not one client: concurrent work
 * would otherwise interleave its transactions on a single session, and Drizzle gives each transaction its own
 * connection only from a pool. Hyperdrive pools the origin connections behind it.
 */
export async function withCoreDb<T>(env: CoreEnv, work: (db: NodePgDatabase) => Promise<T>): Promise<T> {
	const pool = new Pool({
		connectionString: env.HYPERDRIVE.connectionString,
		// A Worker invocation has at most six connections waiting at once; keep one free for its fetches.
		max: 5,
		connectionTimeoutMillis: 5_000,
	});
	pool.on('error', (error) => console.warn({ tag: 'DB', msg: 'Idle connection dropped', error: error.message }));
	try {
		return await work(drizzle({ client: pool }));
	} finally {
		await pool.end().catch(() => undefined);
	}
}
