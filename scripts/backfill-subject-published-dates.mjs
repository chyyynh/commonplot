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

const { backfillSubjectPublishedDates } = await import('../src/operations/subject-published-date-backfill.ts');

const connectionString = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
	throw new Error('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is required');
}
// Writes are opt-in: the default run only reports what it would change.
const apply = process.argv.includes('--apply');
const limit = Number(process.env.SUBJECT_PUBLISHED_DATE_BACKFILL_LIMIT ?? '500');
const connectionUrl = new URL(connectionString);
const usesSystemCertificateStore = connectionUrl.searchParams.get('sslrootcert') === 'system';
if (usesSystemCertificateStore) {
	// `sslrootcert=system` is a libpq/Prisma convention. node-postgres treats
	// `system` as a file path, so use Node's trusted roots and hostname check.
	connectionUrl.searchParams.delete('sslrootcert');
	connectionUrl.searchParams.delete('sslmode');
}
const client = new Client({
	application_name: 'newsence-subject-published-date-backfill',
	connectionString: connectionUrl.href,
	connectionTimeoutMillis: 10_000,
	query_timeout: 60_000,
	...(usesSystemCertificateStore ? { ssl: { rejectUnauthorized: true } } : {}),
});

try {
	await client.connect();
	const { rows, ...result } = await backfillSubjectPublishedDates(drizzle(client), { apply, limit });
	for (const row of rows.slice(0, 20)) {
		console.info(
			[
				new Date(row.inherited_date).toISOString().slice(0, 10),
				row.enrichment_status.padEnd(9),
				row.carrier_count > 1 ? `${row.carrier_count} carriers` : '          ',
				(row.url ?? '').slice(0, 76),
			].join('  '),
		);
	}
	if (rows.length > 20) console.info(`… and ${rows.length - 20} more`);
	const { appliedIds, ...counts } = result;
	console.info({ event: 'subject_published_date_backfill_completed', ...counts });
	if (result.dryRun) {
		console.info('Dry run. Re-run with --apply to write these dates.');
	} else {
		// Keep this line: it is the only record of which rows the write touched.
		console.info(`applied_ids=${JSON.stringify(appliedIds)}`);
	}
} finally {
	await client.end();
}
