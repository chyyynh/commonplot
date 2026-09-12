import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';

// Operator-only: consume a reviewed offline preview, never infer or reprocess
// documents here. Keep the before snapshot alongside the preview for recovery.
const file = process.argv[2];
assert.ok(
	file,
	'Usage: pnpm exec node --env-file=../../web-tanstack/.env.local scripts/apply-pdf-markdown-backfill.mjs <preview.json> [--apply]',
);
assert.ok(
	process.argv.slice(3).every((argument) => argument === '--apply'),
	'Unknown argument',
);
const json = await readFile(file, 'utf8');
const rows = z
	.array(
		z.object({
			id: z.uuid(),
			lang: z.string().min(1).max(35),
			title: z.string().nullable(),
			source: z.enum(['original', 'machine']),
			content: z.string().min(1).max(2_000_000),
			previousContent: z.string().min(1).max(2_000_000),
			alignment: z.json().nullable(),
			previousAlignment: z.json().nullable(),
			legacy: z.boolean(),
		}),
	)
	.max(500)
	.parse(JSON.parse(json));
assert.equal(new Set(rows.map((row) => `${row.id}:${row.lang}`)).size, rows.length, 'Duplicate rendition');
const changed = rows.filter(
	(row) => row.content !== row.previousContent || JSON.stringify(row.alignment) !== JSON.stringify(row.previousAlignment),
);
const ids = [...new Set(changed.map((row) => row.id))].sort();
console.info({
	mode: process.argv.includes('--apply') ? 'apply' : 'preview',
	sha256: createHash('sha256').update(json).digest('hex'),
	resources: ids,
	renditions: changed.length,
});
if (!process.argv.includes('--apply')) process.exit(0);
assert.ok(ids.length, 'Nothing to apply');
const url = new URL(process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE);
if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
try {
	await db.query('BEGIN');
	await db.query("SET LOCAL lock_timeout = '5s'");
	await db.query("SET LOCAL statement_timeout = '30s'");
	const locked = await db.query(
		"SELECT id FROM resources WHERE id=ANY($1::uuid[]) AND file_type='application/pdf' ORDER BY id FOR UPDATE",
		[ids],
	);
	assert.equal(locked.rowCount, ids.length, 'Resource no longer exists or is not a PDF');
	for (const row of changed) {
		const result = await db.query(
			`UPDATE resource_translations SET content=$3, alignment=$4::jsonb, updated_at=now()
			WHERE resource_id=$1 AND lang=$2 AND title IS NOT DISTINCT FROM $5 AND source=$6
			AND ((content=$7 AND alignment IS NOT DISTINCT FROM $8::jsonb) OR (content=$3 AND alignment IS NOT DISTINCT FROM $4::jsonb))`,
			[
				row.id,
				row.lang,
				row.content,
				row.alignment === null ? null : JSON.stringify(row.alignment),
				row.title,
				row.source,
				row.previousContent,
				row.previousAlignment === null ? null : JSON.stringify(row.previousAlignment),
			],
		);
		assert.equal(result.rowCount, 1, `Rendition changed since preview: ${row.id}/${row.lang}`);
	}
	await db.query('UPDATE resources SET updated_at=now() WHERE id=ANY($1::uuid[])', [ids]);
	await db.query('COMMIT');
	console.info({ applied: changed.length, resourceIds: ids });
} catch (error) {
	await db.query('ROLLBACK');
	throw error;
} finally {
	await db.end();
}
