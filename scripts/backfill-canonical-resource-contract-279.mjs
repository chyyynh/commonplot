#!/usr/bin/env node

import pg from 'pg';

const { Client } = pg;

const LOCK_NAME = 'newsence:canonical-resource-contract-backfill-279';
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 2_000;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const batchSizeArg = args.find((arg) => arg.startsWith('--batch-size='));
const batchSize = batchSizeArg ? Number(batchSizeArg.slice('--batch-size='.length)) : DEFAULT_BATCH_SIZE;
const unknownArgs = args.filter((arg) => arg !== '--' && arg !== '--apply' && arg !== '--dry-run' && !arg.startsWith('--batch-size='));

if (unknownArgs.length > 0) throw new Error(`Unknown arguments: ${unknownArgs.join(', ')}`);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
	throw new Error(`--batch-size must be an integer between 1 and ${MAX_BATCH_SIZE}`);
}

const connectionString =
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
	throw new Error('Set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, DIRECT_URL, or DATABASE_URL before running this script');
}

function nodePostgresConnectionString(value) {
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

const eligibleResourceSql = `
	r.scope = 'corpus'
	AND r.created_at < $1::timestamp
	AND (
		(r.kind = 'blog' AND r.resource_platform IS NULL)
		OR (r.kind = 'forum' AND r.resource_platform = 'hackernews')
		OR (r.kind = 'post' AND r.resource_platform = 'twitter')
		OR (r.kind = 'video' AND r.resource_platform = 'youtube')
		OR (r.kind = 'paper' AND r.resource_platform IS NULL)
	)
	AND (r.source_revision IS NULL OR r.enrichment_status IN ('pending', 'failed'))
	AND NULLIF(BTRIM(t.title), '') IS NOT NULL
	AND t.content IS NOT NULL
	AND OCTET_LENGTH(t.content) > 0
	AND (
		r.resource_platform IS NULL
		OR EXISTS (
			SELECT 1
			FROM resource_identifiers identifier
			WHERE identifier.resource_id = r.id
			  AND identifier.scheme = r.resource_platform
			  AND NULLIF(BTRIM(identifier.value), '') IS NOT NULL
		)
	)
	AND JSONB_TYPEOF(r.creators) = 'array'
	AND (
		(r.kind = 'blog' AND (
			r.kind_metadata IS NULL
			OR (JSONB_TYPEOF(r.kind_metadata) = 'object' AND r.kind_metadata @> '{"schemaVersion":1}'::jsonb)
		))
		OR (r.kind IN ('forum', 'video', 'paper')
			AND JSONB_TYPEOF(r.kind_metadata) = 'object'
			AND r.kind_metadata @> '{"schemaVersion":1}'::jsonb)
		OR (r.kind = 'post'
			AND JSONB_TYPEOF(r.kind_metadata) = 'object'
			AND r.kind_metadata @> '{"schemaVersion":1}'::jsonb
			AND JSONB_TYPEOF(r.kind_metadata->'attachments') = 'array')
	)`;

function count(value) {
	return Number(value ?? 0);
}

async function loadSnapshot(client, cutoff) {
	const result = await client.query(
		`
			WITH resource_state AS (
				SELECT
					r.enrichment_status,
					r.source_revision,
					NULLIF(BTRIM(t.title), '') IS NOT NULL AS has_title,
					t.content IS NOT NULL AND OCTET_LENGTH(t.content) > 0 AS has_content,
					(
						r.resource_platform IS NULL
						OR EXISTS (
							SELECT 1
							FROM resource_identifiers identifier
							WHERE identifier.resource_id = r.id
							  AND identifier.scheme = r.resource_platform
							  AND NULLIF(BTRIM(identifier.value), '') IS NOT NULL
						)
					) AS has_platform_identifier,
					(
						JSONB_TYPEOF(r.creators) = 'array'
						AND (
							(r.kind = 'blog' AND (
								r.kind_metadata IS NULL
								OR (JSONB_TYPEOF(r.kind_metadata) = 'object' AND r.kind_metadata @> '{"schemaVersion":1}'::jsonb)
							))
							OR (r.kind IN ('forum', 'video', 'paper')
								AND JSONB_TYPEOF(r.kind_metadata) = 'object'
								AND r.kind_metadata @> '{"schemaVersion":1}'::jsonb)
							OR (r.kind = 'post'
								AND JSONB_TYPEOF(r.kind_metadata) = 'object'
								AND r.kind_metadata @> '{"schemaVersion":1}'::jsonb
								AND JSONB_TYPEOF(r.kind_metadata->'attachments') = 'array')
						)
					) AS has_valid_contract
				FROM resources r
				LEFT JOIN resource_translations t
				  ON t.resource_id = r.id
				 AND t.lang = r.original_lang
				WHERE r.scope = 'corpus'
				  AND r.created_at < $1::timestamp
				  AND (
					(r.kind = 'blog' AND r.resource_platform IS NULL)
					OR (r.kind = 'forum' AND r.resource_platform = 'hackernews')
					OR (r.kind = 'post' AND r.resource_platform = 'twitter')
					OR (r.kind = 'video' AND r.resource_platform = 'youtube')
					OR (r.kind = 'paper' AND r.resource_platform IS NULL)
				  )
			)
			SELECT
				COUNT(*) FILTER (WHERE
					(source_revision IS NULL OR enrichment_status IN ('pending', 'failed'))
					AND has_title AND has_content AND has_platform_identifier AND has_valid_contract
				) AS candidate_rows,
				COUNT(*) FILTER (WHERE
					source_revision IS NULL
					AND has_title AND has_content AND has_platform_identifier AND has_valid_contract
				) AS missing_revisions,
				COUNT(*) FILTER (WHERE
					enrichment_status = 'pending'
					AND has_title AND has_content AND has_platform_identifier AND has_valid_contract
				) AS pending_transitions,
				COUNT(*) FILTER (WHERE
					enrichment_status = 'failed'
					AND has_title AND has_content AND has_platform_identifier AND has_valid_contract
				) AS failed_transitions,
				COUNT(*) FILTER (WHERE
					enrichment_status IN ('pending', 'failed') AND (NOT has_title OR NOT has_content)
				) AS incomplete_rows,
				COUNT(*) FILTER (WHERE
					enrichment_status IN ('pending', 'failed')
					AND has_title AND has_content AND NOT has_platform_identifier
				) AS missing_identifier_rows,
				COUNT(*) FILTER (WHERE
					has_title AND has_content AND has_platform_identifier AND NOT has_valid_contract
				) AS invalid_contract_rows
			FROM resource_state
		`,
		[cutoff],
	);
	const row = result.rows[0];
	return {
		candidateRows: count(row.candidate_rows),
		missingRevisions: count(row.missing_revisions),
		pendingTransitions: count(row.pending_transitions),
		failedTransitions: count(row.failed_transitions),
		incompleteRows: count(row.incomplete_rows),
		missingIdentifierRows: count(row.missing_identifier_rows),
		invalidContractRows: count(row.invalid_contract_rows),
	};
}

function printSnapshot(label, snapshot) {
	process.stdout.write(`\n${label}\n${JSON.stringify(snapshot, null, 2)}\n`);
}

async function applyBatch(client, cutoff) {
	const result = await client.query(
		`
			WITH candidate AS MATERIALIZED (
				SELECT
					r.id,
					r.source_revision IS NULL AS revision_missing,
					r.enrichment_status IN ('pending', 'failed') AS status_transition_needed,
					ENCODE(
						DIGEST(
							JSONB_BUILD_OBJECT(
								'content', t.content,
								'fileType', r.file_type,
								'kind', r.kind,
								'originalLang', r.original_lang,
								'publishedDate', CASE
									WHEN r.published_date IS NULL THEN NULL
									ELSE TO_CHAR(DATE_TRUNC('milliseconds', r.published_date), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
								END,
								'resourcePlatform', r.resource_platform,
								'summary', t.summary,
								'title', t.title,
								'translationSource', t.source,
								'url', r.url
							)::text,
							'sha256'
						),
						'hex'
					) AS revision
				FROM resources r
				JOIN resource_translations t
				  ON t.resource_id = r.id
				 AND t.lang = r.original_lang
				WHERE ${eligibleResourceSql}
				ORDER BY r.id
				LIMIT $2
				FOR UPDATE OF r SKIP LOCKED
			),
			updated AS (
				UPDATE resources r
				SET source_revision = COALESCE(r.source_revision, candidate.revision),
					enrichment_status = CASE
						WHEN r.enrichment_status IN ('pending', 'failed') THEN 'enriched'
						ELSE r.enrichment_status
					END,
					enrichment_attempts = CASE
						WHEN r.enrichment_status IN ('pending', 'failed') THEN 0
						ELSE r.enrichment_attempts
					END,
					updated_at = NOW()
				FROM candidate
				WHERE r.id = candidate.id
				RETURNING candidate.revision_missing, candidate.status_transition_needed
			)
			SELECT
				COUNT(*) AS updated_rows,
				COUNT(*) FILTER (WHERE revision_missing) AS revisions_added,
				COUNT(*) FILTER (WHERE status_transition_needed) AS statuses_transitioned
			FROM updated
		`,
		[cutoff, batchSize],
	);
	const row = result.rows[0];
	return {
		updatedRows: count(row.updated_rows),
		revisionsAdded: count(row.revisions_added),
		statusesTransitioned: count(row.statuses_transitioned),
	};
}

async function run() {
	const client = new Client({ connectionString: nodePostgresConnectionString(connectionString) });
	let locked = false;
	await client.connect();
	try {
		const extension = await client.query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS available");
		if (!extension.rows[0]?.available) throw new Error('The pgcrypto extension is required for SHA-256 source revisions');

		const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [LOCK_NAME]);
		locked = lock.rows[0]?.acquired === true;
		if (!locked) throw new Error('Another #279 canonical resource backfill is already running');

		const cutoffResult = await client.query(`SELECT TO_CHAR(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS cutoff`);
		const cutoff = cutoffResult.rows[0].cutoff;
		const before = await loadSnapshot(client, cutoff);
		printSnapshot(`Canonical resource backfill #279 (${apply ? 'apply' : 'dry-run'}, cutoff ${cutoff} UTC)`, before);
		if (before.invalidContractRows > 0) {
			throw new Error(`Refusing to continue: ${before.invalidContractRows} content-complete rows have an invalid canonical contract`);
		}
		if (!apply) {
			process.stdout.write('\nDry-run only. Re-run with --apply to persist these changes.\n');
			return;
		}

		let batches = 0;
		let updatedRows = 0;
		let revisionsAdded = 0;
		let statusesTransitioned = 0;
		let emptyBatchRetries = 0;
		while (true) {
			const batch = await applyBatch(client, cutoff);
			if (batch.updatedRows === 0) {
				const remaining = await loadSnapshot(client, cutoff);
				if (remaining.candidateRows === 0) break;
				emptyBatchRetries += 1;
				if (emptyBatchRetries > 5) {
					throw new Error(`${remaining.candidateRows} eligible rows remain locked after five retries`);
				}
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				continue;
			}
			emptyBatchRetries = 0;
			batches += 1;
			updatedRows += batch.updatedRows;
			revisionsAdded += batch.revisionsAdded;
			statusesTransitioned += batch.statusesTransitioned;
			if (batches === 1 || batches % 10 === 0) {
				process.stdout.write(`Processed ${updatedRows} rows in ${batches} batches\n`);
			}
		}

		const after = await loadSnapshot(client, cutoff);
		printSnapshot('Post-backfill state', after);
		process.stdout.write(`${JSON.stringify({ batches, updatedRows, revisionsAdded, statusesTransitioned }, null, 2)}\n`);
		if (after.candidateRows !== 0) throw new Error(`${after.candidateRows} eligible rows remain after backfill`);
	} finally {
		if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_NAME]).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
}

await run();
