import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CoreDb = NodePgDatabase;

type CoreDbOperation<T> = (db: CoreDb) => Promise<T>;

export function isValidUuid(value: string): boolean {
	return UUID_RE.test(value);
}

export async function withCoreDb<T>(env: CoreEnv, operation: CoreDbOperation<T>): Promise<T> {
	// Keep the edge client scoped to this invocation. Hyperdrive owns the
	// underlying origin pool and automatically cleans up the edge connection
	// when the request, Workflow, Queue consumer, or Durable Object ends.
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return operation(drizzle(client));
}
