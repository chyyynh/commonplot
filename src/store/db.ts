import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

/** One short-lived connection per unit of work, closed even when the work throws. */
export async function withCoreDb<T>(env: CoreEnv, work: (db: NodePgDatabase) => Promise<T>): Promise<T> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	try {
		return await work(drizzle(client));
	} finally {
		await client.end().catch(() => undefined);
	}
}
