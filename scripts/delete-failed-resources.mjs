#!/usr/bin/env node

import { registerHooks } from 'node:module';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.includes('/workers/core-worker/src/')) {
			return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
		}
		return nextResolve(specifier, context);
	},
});

const { deleteFailedResources } = await import('../src/operations/failed-resource-cleanup.ts');

const connectionString = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
	throw new Error('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is required');
}
// Deletes are opt-in: the default run only reports what it would remove.
const apply = process.argv.includes('--apply');
const connectionUrl = new URL(connectionString);
const usesSystemCertificateStore = connectionUrl.searchParams.get('sslrootcert') === 'system';
if (usesSystemCertificateStore) {
	// `sslrootcert=system` is a libpq/Prisma convention. node-postgres treats
	// `system` as a file path, so use Node's trusted roots and hostname check.
	connectionUrl.searchParams.delete('sslrootcert');
	connectionUrl.searchParams.delete('sslmode');
}
const client = new Client({
	application_name: 'newsence-failed-resource-cleanup',
	connectionString: connectionUrl.href,
	connectionTimeoutMillis: 10_000,
	query_timeout: 120_000,
	...(usesSystemCertificateStore ? { ssl: { rejectUnauthorized: true } } : {}),
});

try {
	await client.connect();
	const { carriers, deletedIds, ...counts } = await deleteFailedResources(drizzle(client), { apply });
	console.info({ event: 'failed_resource_cleanup_completed', ...counts });
	if (counts.dryRun) {
		console.info('Dry run. Re-run with --apply to delete these resources.');
	} else {
		// Keep these two lines: they are the only record of what the delete removed
		// and which carriers are now worth resyncing to re-attempt their subject.
		console.info(`deleted_ids=${JSON.stringify(deletedIds)}`);
		console.info(`carriers_to_resync=${JSON.stringify(carriers.map((row) => row.carrier_id))}`);
	}
} finally {
	await client.end();
}
