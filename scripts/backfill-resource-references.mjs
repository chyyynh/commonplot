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

const { backfillResourceReferences } = await import('../src/operations/resource-reference-backfill.ts');

const connectionString = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
	throw new Error('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is required');
}
const parsedLimit = Number(process.env.RESOURCE_REFERENCE_BACKFILL_LIMIT ?? '25');
const afterResourceId = process.env.RESOURCE_REFERENCE_BACKFILL_AFTER?.trim() || null;
const connectionUrl = new URL(connectionString);
const usesSystemCertificateStore = connectionUrl.searchParams.get('sslrootcert') === 'system';
if (usesSystemCertificateStore) {
	// `sslrootcert=system` is a libpq/Prisma convention. node-postgres treats
	// `system` as a file path, so use Node's trusted roots and hostname check.
	connectionUrl.searchParams.delete('sslrootcert');
	connectionUrl.searchParams.delete('sslmode');
}
const client = new Client({
	application_name: 'newsence-resource-reference-backfill',
	connectionString: connectionUrl.href,
	connectionTimeoutMillis: 10_000,
	query_timeout: 30_000,
	...(usesSystemCertificateStore ? { ssl: { rejectUnauthorized: true } } : {}),
});

try {
	await client.connect();
	const result = await backfillResourceReferences(drizzle(client), { afterResourceId, limit: parsedLimit });
	console.info({ event: 'resource_reference_backfill_page_completed', ...result });
	if (result.results.some((item) => item.error)) process.exitCode = 1;
} finally {
	await client.end();
}
