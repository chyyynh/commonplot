import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { entityKey, type ResourceEntity, type ResourceKind, type ResourcePlatform } from '../contracts/resource';

/** The languages every titled Resource is summarized in, each written directly rather than translated. */
export const SUMMARY_LANGS = ['zh-Hant', 'en'] as const;
export type SummaryLang = (typeof SUMMARY_LANGS)[number];
/**
 * What Core derives from an original after it is written; each lands, fails and retries on its own. Summaries and
 * translations have a language; a translation is written by its own Workflow.
 */
export type Derivation = Readonly<
	{ kind: 'summary'; lang: SummaryLang } | { kind: 'entities'; lang: '' } | { kind: 'translation'; lang: TranslationLang }
>;
/** zh-Hant translates the title, and the content where it translates automatically; English is only ever a title. */
export type TranslationLang = 'zh-Hant' | 'en';

/** A pending derivation belongs to the attempt that wrote its original this long before the sweep may take it. */
const DERIVATION_LEASE = sql`interval '15 minutes'`;
/** After this many failures a derivation waits for the next acquisition of its original. */
const MAX_DERIVATION_ATTEMPTS = 5;

/**
 * In the transaction that writes an original: the derivations it needs wait for that text, and any other is dropped.
 * One already done for the same text stays done. Returns those now pending.
 */
export async function requireDerivations(tx: NodePgDatabase, resourceId: string, required: readonly Derivation[]) {
	const kinds = required.map(({ kind }) => kind);
	const langs = required.map(({ lang }) => lang);
	await tx.execute(sql`
		DELETE FROM resource_derivations
		WHERE resource_id = ${resourceId}::uuid
		  AND (kind, lang) NOT IN (SELECT * FROM unnest(${sql.param(kinds)}::text[], ${sql.param(langs)}::text[]))
	`);
	if (!required.length) return [];
	const { rows } = await tx.execute<Derivation>(sql`
		INSERT INTO resource_derivations AS current (resource_id, kind, lang, input_hash, status, attempts, retry_at, error, output, updated_at)
		SELECT resource.id, required.kind, required.lang, resource.text_hash, 'pending', 0, NOW() + ${DERIVATION_LEASE}, NULL, NULL, NOW()
		FROM resources resource CROSS JOIN unnest(${sql.param(kinds)}::text[], ${sql.param(langs)}::text[]) AS required(kind, lang)
		WHERE resource.id = ${resourceId}::uuid
		ON CONFLICT (resource_id, kind, lang) DO UPDATE SET
			(input_hash, status, attempts, retry_at, error, updated_at) =
			(EXCLUDED.input_hash, 'pending', 0, EXCLUDED.retry_at, NULL, NOW()),
			-- A translation merges its parts onto the same text, so a new text starts from nothing.
			output = CASE WHEN current.input_hash = EXCLUDED.input_hash THEN current.output END
		WHERE current.input_hash <> EXCLUDED.input_hash OR current.status <> 'done'
		RETURNING kind, lang
	`);
	return rows;
}

/** Locks the Resource while its text is still the one a derivation read; null once it was replaced. */
async function lockDerivedText(tx: NodePgDatabase, resourceId: string, inputHash: string) {
	const { rows } = await tx.execute<{ scope: 'corpus' | 'private' }>(sql`
		SELECT scope FROM resources WHERE id = ${resourceId}::uuid AND text_hash = ${inputHash} FOR UPDATE
	`);
	return rows[0] ?? null;
}

async function settleDerivation(
	tx: NodePgDatabase,
	resourceId: string,
	{ kind, lang }: Derivation,
	inputHash: string,
	output: unknown = null,
) {
	await tx.execute(sql`
		UPDATE resource_derivations SET status = 'done', output = ${output === null ? null : JSON.stringify(output)}::jsonb,
			retry_at = NULL, error = NULL, updated_at = NOW()
		WHERE resource_id = ${resourceId}::uuid AND kind = ${kind} AND lang = ${lang} AND input_hash = ${inputHash}
	`);
}

/** Records a summary of the text `inputHash` names; false when that text was replaced meanwhile. */
export async function completeSummary(db: NodePgDatabase, resourceId: string, inputHash: string, lang: SummaryLang, summary: string) {
	return db.transaction(async (tx) => {
		if (!(await lockDerivedText(tx, resourceId, inputHash))) return false;
		await settleDerivation(tx, resourceId, { kind: 'summary', lang }, inputHash, { summary });
		return true;
	});
}

/** Replaces what a corpus Resource is about; false when its text was replaced meanwhile. */
export async function completeEntities(db: NodePgDatabase, resourceId: string, inputHash: string, entities: readonly ResourceEntity[]) {
	return db.transaction(async (tx) => {
		const resource = await lockDerivedText(tx, resourceId, inputHash);
		if (resource?.scope !== 'corpus') return false;
		await replaceResourceEntities(tx, resourceId, entities);
		await settleDerivation(tx, resourceId, { kind: 'entities', lang: '' }, inputHash);
		return true;
	});
}

/** Records a failed derivation; it runs again after a doubling wait, until it gives up. */
export async function failDerivation(db: NodePgDatabase, resourceId: string, { kind, lang }: Derivation, inputHash: string, error: string) {
	await db.execute(sql`
		UPDATE resource_derivations SET
			status = 'failed', attempts = attempts + 1, error = LEFT(${error}, 500), updated_at = NOW(),
			retry_at = CASE WHEN attempts + 1 >= ${MAX_DERIVATION_ATTEMPTS} THEN NULL
			                ELSE NOW() + interval '30 minutes' * power(2, attempts) END
		WHERE resource_id = ${resourceId}::uuid AND kind = ${kind} AND lang = ${lang} AND input_hash = ${inputHash}
		  -- A stale attempt failing late never undoes one that landed.
		  AND status <> 'done'
	`);
}

export type DueDerivation = Derivation & Readonly<{ resourceId: string; inputHash: string; attempts: number }>;

/** Takes derivations whose attempt never settled or whose wait is over, leasing them so the next sweep skips them. */
export async function claimDueDerivations(db: NodePgDatabase, limit: number): Promise<DueDerivation[]> {
	const { rows } = await db.execute<DueDerivation>(sql`
		UPDATE resource_derivations derivation SET retry_at = NOW() + ${DERIVATION_LEASE}
		FROM (
			SELECT due.resource_id, due.kind, due.lang
			FROM resource_derivations due
			JOIN resources resource ON resource.id = due.resource_id AND resource.text_hash = due.input_hash
			WHERE due.status <> 'done' AND due.retry_at <= NOW()
			ORDER BY due.retry_at
			LIMIT ${limit}
			FOR UPDATE OF due SKIP LOCKED
		) claimed
		WHERE derivation.resource_id = claimed.resource_id AND derivation.kind = claimed.kind AND derivation.lang = claimed.lang
		RETURNING derivation.resource_id::text AS "resourceId", derivation.kind, derivation.lang, derivation.input_hash AS "inputHash",
		          derivation.attempts
	`);
	return rows;
}

/** What a derivation reads from a stored original. */
export type DerivationSource = Readonly<{
	kind: ResourceKind;
	resourcePlatform: ResourcePlatform | null;
	source: string;
	originalLang: string;
	title: string | null;
	/** What the source said about itself; a hint for a summary, never one. */
	description: string | null;
	content: string;
}>;

/** The stored original a derivation reads, while it is still the text that derivation was required for. */
export async function loadDerivationSource(db: NodePgDatabase, resourceId: string, inputHash: string) {
	const { rows } = await db.execute<DerivationSource>(sql`
		SELECT resource.kind, resource.resource_platform AS "resourcePlatform", COALESCE(resource.source_name, '') AS source,
		       resource.original_lang AS "originalLang", resource.title, resource.description, COALESCE(body.markdown, '') AS content
		FROM resources resource
		LEFT JOIN resource_content body ON body.resource_id = resource.id
		WHERE resource.id = ${resourceId}::uuid AND resource.text_hash = ${inputHash}
	`);
	return rows[0] ?? null;
}

/** Replaces what a Resource is about. Run inside the caller's transaction. */
export async function replaceResourceEntities(db: NodePgDatabase, resourceId: string, entities: readonly ResourceEntity[]) {
	await db.execute(sql`DELETE FROM resource_entities WHERE resource_id = ${resourceId}::uuid`);
	if (!entities.length) return;
	// Sorted keys lock entity rows in one order across concurrent writers.
	const rows = entities
		.map((entity) => ({ ...entity, key: entityKey(entity.name) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	await db.execute(sql`
		WITH incoming AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
			AS incoming(key text, name text, type text, weight real)
		), entity AS (
			INSERT INTO entities (key, name, type)
			SELECT DISTINCT ON (key) key, name, type FROM incoming ORDER BY key, weight DESC
			ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
			RETURNING id, key
		)
		INSERT INTO resource_entities (resource_id, entity_id, weight)
		SELECT DISTINCT ON (entity.id) ${resourceId}::uuid, entity.id, incoming.weight
		FROM incoming JOIN entity USING (key)
		ORDER BY entity.id, incoming.weight DESC
	`);
}
