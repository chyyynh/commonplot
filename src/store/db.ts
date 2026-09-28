import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

export async function connectCoreDb(env: CoreEnv) {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return drizzle(client);
}
