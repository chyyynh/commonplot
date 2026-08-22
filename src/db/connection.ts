import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

export type CoreDb = NodePgDatabase;

export async function connectCoreDb(env: CoreEnv): Promise<CoreDb> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return drizzle({ client });
}
