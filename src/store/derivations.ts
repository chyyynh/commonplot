import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { CONTENT_TRANSLATION_LANGS, type ContentTranslationLang, type SummaryLang } from '../contracts/languages';
import { entityKey, type ResourceEntity } from '../contracts/resource';
import { type EntityType, RESOURCE_KINDS, type ResourceKind, type ResourcePlatform } from '../contracts/resource-kinds';
import { isWrittenInOriginal } from '../contracts/resource-language';
import { PDF_MIME } from '../contracts/storage-keys';

/**
 * What Core derives from an original after it is written; each lands, fails and retries on its own. A `summary` row is
 * the Resource's card in its language, `{ title?, summary }`: every titled Resource has one in each summary language,
 * and its title is there unless the original is already in that language. A `translation` row is the content alone,
 * written by its own Workflow where content translates automatically or a reader asked for it.
 */
export type Derivation = Readonly<
	{ kind: 'summary'; lang: SummaryLang } | { kind: 'entities'; lang: '' } | { kind: 'translation'; lang: ContentTranslationLang }
>;

/** A `summary` row's output. */
export type SummaryCard = Readonly<{ title?: string; summary: string }>;

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

/** Records a card of the text `inputHash` names; false when that text was replaced meanwhile. */
export async function completeSummary(db: NodePgDatabase, resourceId: string, inputHash: string, lang: SummaryLang, card: SummaryCard) {
	return db.transaction(async (tx) => {
		if (!(await lockDerivedText(tx, resourceId, inputHash))) return false;
		await settleDerivation(tx, resourceId, { kind: 'summary', lang }, inputHash, card);
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

type DueDerivation = Derivation & Readonly<{ resourceId: string; inputHash: string; attempts: number }>;

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

/** More than any derivation reads (a summary 10k, entities 20k), so a long original never bloats the step's checkpoint. */
const DERIVATION_SOURCE_MAX_CHARS = 20_000;

/** What a derivation reads from a stored original. */
export type DerivationSource = Readonly<{
	kind: ResourceKind;
	resourcePlatform: ResourcePlatform | null;
	originalLang: string;
	source: string;
	title: string | null;
	/** What the source said about itself; a hint for a summary, never one. */
	description: string | null;
	content: string;
}>;

/** The stored original a derivation reads, while it is still the text that derivation was required for. */
export async function loadDerivationSource(db: NodePgDatabase, resourceId: string, inputHash: string) {
	const { rows } = await db.execute<DerivationSource>(sql`
		SELECT resource.kind, resource.resource_platform AS "resourcePlatform", resource.original_lang AS "originalLang",
		       COALESCE(resource.source_name, '') AS source,
		       resource.title, resource.description, LEFT(COALESCE(body.markdown, ''), ${DERIVATION_SOURCE_MAX_CHARS}::integer) AS content
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

export type EntityCandidate = Readonly<{
	/** The key without its maker qualifier, which a name in a text is looked up by. */
	bare: string;
	name: string;
	type: EntityType;
	/** How many Resources name it. */
	uses: number;
	/** The Resource most about it, so a reader can tell same-named entities apart. */
	example: string | null;
}>;

/** Stored entities whose name, without a maker qualifier, has one of the keys. */
export async function listEntityCandidates(db: NodePgDatabase, keys: readonly string[]): Promise<EntityCandidate[]> {
	if (!keys.length) return [];
	const result = await db.execute<EntityCandidate>(sql`
		SELECT split_part(e.key, '(', 1) AS bare, e.name, e.type,
		       (SELECT count(*)::int FROM resource_entities used WHERE used.entity_id = e.id) AS uses,
		       (SELECT left(COALESCE(r.title, body.markdown), 120)
		        FROM resource_entities top
		        JOIN resources r ON r.id = top.resource_id
		        LEFT JOIN resource_content body ON body.resource_id = r.id
		        WHERE top.entity_id = e.id
		        ORDER BY top.weight DESC LIMIT 1) AS example
		FROM entities e
		WHERE split_part(e.key, '(', 1) = ANY(${sql.param([...keys])}::text[])
	`);
	return result.rows;
}

// Translations: which Resources' content translates, and into what

export const TextHashSchema = z.hash('md5').lowercase();

export type ResourceTranslationCandidate = Readonly<{
	fileType: string | null;
	kind: ResourceKind;
	originalLang: string;
	resourcePlatform: ResourcePlatform | null;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

/** The one translation policy: whose content may be translated into `lang`. */
export function isTranslatable(candidate: ResourceTranslationCandidate, lang: ContentTranslationLang): boolean {
	if (isWrittenInOriginal(candidate.originalLang, lang)) return false;
	// A private file Resource exists only while its upload is in the owner's library: Web deletes it with the upload.
	if (candidate.scope === 'private') {
		return candidate.kind === 'file' && candidate.fileType === PDF_MIME && candidate.resourcePlatform === null && candidate.url === null;
	}
	return (
		Boolean(candidate.url) &&
		RESOURCE_KINDS[candidate.kind].translatable &&
		(candidate.fileType !== PDF_MIME || (candidate.kind === 'paper' && candidate.resourcePlatform === null))
	);
}

const CANDIDATE_COLUMNS = sql`resource.id::text, resource.text_hash AS "textHash", resource.kind, resource.scope, resource.url,
	resource.file_type AS "fileType", resource.resource_platform AS "resourcePlatform", resource.original_lang AS "originalLang"`;

/** Longer automatic translations wait for a reader to request and pay for them. */
const MAX_AUTOMATIC_CONTENT_CHARACTERS = 150_000;

export type ResourceTranslationInput = ResourceTranslationCandidate & {
	id: string;
	/** The card's title in the target language, else the original's; with `summary`, context for the content. */
	title: string;
	/** The card's summary in the target language, when derived already. */
	summary: string | null;
	content: string;
	hasTranslatedContent: boolean;
};

export async function loadResourceTranslationInput(
	db: NodePgDatabase,
	resourceId: string,
	lang: ContentTranslationLang,
): Promise<{ resource: ResourceTranslationInput; textHash: string } | null> {
	const result = await db.execute<ResourceTranslationInput & { textHash: string }>(sql`
		SELECT
			${CANDIDATE_COLUMNS},
			COALESCE(NULLIF(BTRIM(card.output->>'title'), ''), resource.title, '') AS title,
			card.output->>'summary' AS summary,
			COALESCE(original.markdown, '') AS content,
			translation.output->>'content' IS NOT NULL AS "hasTranslatedContent"
		FROM resources resource
		LEFT JOIN resource_content original ON original.resource_id = resource.id
		LEFT JOIN resource_derivations card
		  ON card.resource_id = resource.id AND card.kind = 'summary' AND card.lang = ${lang} AND card.status = 'done'
		LEFT JOIN resource_derivations translation
		  ON translation.resource_id = resource.id AND translation.kind = 'translation' AND translation.lang = ${lang}
		 AND translation.status = 'done'
		WHERE resource.id = ${resourceId}::uuid
	`);
	const row = result.rows[0];
	if (!row?.textHash || !isTranslatable(row, lang)) return null;
	const { textHash, ...resource } = row;
	return { resource, textHash };
}

/** Writes a content translation of the text `textHash` names; false once that text is gone. */
export async function persistMachineTranslation(
	db: NodePgDatabase,
	resourceId: string,
	textHash: string,
	lang: ContentTranslationLang,
	{ content, alignment }: Readonly<{ content: string; alignment: unknown }>,
): Promise<boolean> {
	const result = await db.execute<{ resource_id: string }>(sql`
		INSERT INTO resource_derivations AS current (resource_id, kind, lang, input_hash, status, attempts, output, updated_at)
		SELECT resource.id, 'translation', ${lang}, ${textHash}, 'done', 0,
		       jsonb_build_object('content', ${content}::text, 'alignment', ${JSON.stringify(alignment)}::jsonb), NOW()
		FROM resources resource
		WHERE resource.id = ${resourceId}::uuid AND resource.text_hash = ${textHash}
		FOR UPDATE OF resource
		ON CONFLICT (resource_id, kind, lang) DO UPDATE SET
			output = EXCLUDED.output, input_hash = EXCLUDED.input_hash, status = 'done', retry_at = NULL, error = NULL, updated_at = NOW()
		RETURNING resource_id::text
	`);
	return result.rows.length > 0;
}

/**
 * Monitor discoveries, and the subjects their carriers point at, translate in full at the operator's cost. Everything
 * else translates its content only when a reader asks for it.
 */
const AUTOMATIC_CONTENT_TRANSLATION_SQL = sql`(
	EXISTS (
		SELECT 1 FROM resource_requests discovery
		WHERE discovery.requester = 'source' AND discovery.status = 'fulfilled'
		  AND (discovery.resource_id = resource.id
		       OR discovery.resource_id IN (SELECT carrier.id FROM resources carrier WHERE carrier.subject_resource_id = resource.id))
	)
	AND COALESCE(LENGTH(original.markdown), 0) <= ${MAX_AUTOMATIC_CONTENT_CHARACTERS}
)`;

type StoredTranslationCandidate = ResourceTranslationCandidate &
	Readonly<{ id: string; textHash: string; hasContent: boolean; hasTranslatedContent: boolean; automatic: boolean; translated: boolean }>;

/**
 * A stored Resource whose content translates into `lang`: whether it does so automatically, has a done translation
 * (`hasTranslatedContent`), or has a translation of this text in any state (`translated`).
 */
export async function loadTranslationCandidate(
	db: NodePgDatabase,
	resourceId: string,
	lang: ContentTranslationLang,
): Promise<StoredTranslationCandidate | null> {
	const result = await db.execute<StoredTranslationCandidate>(sql`
		SELECT ${CANDIDATE_COLUMNS},
		       BTRIM(COALESCE(original.markdown, '')) <> '' AS "hasContent",
		       COALESCE(translation.status = 'done' AND translation.output->>'content' IS NOT NULL, false) AS "hasTranslatedContent",
		       ${AUTOMATIC_CONTENT_TRANSLATION_SQL} AS automatic,
		       COALESCE(translation.input_hash = resource.text_hash, false) AS translated
		FROM resources resource
		LEFT JOIN resource_content original ON original.resource_id = resource.id
		LEFT JOIN resource_derivations translation
		  ON translation.resource_id = resource.id AND translation.kind = 'translation' AND translation.lang = ${lang}
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.text_hash IS NOT NULL
	`);
	const row = result.rows[0];
	return row && isTranslatable(row, lang) ? row : null;
}

/**
 * The content translations a written original waits for, in the transaction that wrote it: where its content
 * translates automatically, or to keep one a reader already has of this text.
 */
export async function requiredTranslations(tx: NodePgDatabase, resourceId: string): Promise<Derivation[]> {
	const required: Derivation[] = [];
	for (const lang of CONTENT_TRANSLATION_LANGS) {
		const row = await loadTranslationCandidate(tx, resourceId, lang);
		if (row?.automatic || row?.translated) required.push({ kind: 'translation', lang });
	}
	return required;
}

/**
 * Settles the `lang` translation of the text `textHash` names that a run left open: done when it ended with nothing
 * more to write, failed with `error` when it threw.
 */
export async function settleOpenTranslation(
	db: NodePgDatabase,
	resourceId: string,
	textHash: string,
	lang: ContentTranslationLang,
	error: string | null,
) {
	if (error !== null) return failDerivation(db, resourceId, { kind: 'translation', lang }, textHash, error);
	await db.execute(sql`
		UPDATE resource_derivations SET status = 'done', retry_at = NULL, error = NULL, updated_at = NOW()
		WHERE resource_id = ${resourceId}::uuid AND kind = 'translation' AND lang = ${lang} AND input_hash = ${textHash}
		  AND status <> 'done'
	`);
}

/** The states of the cards and content translations of the text `textHash` names, which an import waits for. */
export async function loadImportDerivationStates(db: NodePgDatabase, resourceId: string, textHash: string) {
	const { rows } = await db.execute<{ status: 'pending' | 'done' | 'failed' }>(sql`
		SELECT status FROM resource_derivations
		WHERE resource_id = ${resourceId}::uuid AND kind IN ('summary', 'translation') AND input_hash = ${textHash}
	`);
	return rows.map(({ status }) => status);
}
