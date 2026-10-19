import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { PDF_MIME } from '../contracts/pdf-policy';
import { RESOURCE_KINDS, type ResourceKind, type ResourcePlatform } from '../contracts/resource-kinds';
import { needsEnglishMetadata } from '../contracts/resource-language';
import { type Derivation, failDerivation, type SummaryLang } from './derivations';

export const TextHashSchema = z.hash('md5').lowercase();

export type ResourceTranslationCandidate = Readonly<{
	fileType: string | null;
	kind: ResourceKind;
	originalLang: string;
	resourcePlatform: ResourcePlatform | null;
	scope: 'corpus' | 'private';
	url: string | null;
}>;

/** The one translation policy. Queries only load rows; every caller decides with this. */
export function isTranslatable(candidate: ResourceTranslationCandidate): boolean {
	if (candidate.originalLang === 'zh-Hant') return false;
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
	title: string;
	/** The English summary, when derived already; context for translating the content. */
	summary: string | null;
	content: string;
	hasTranslatedTitle: boolean;
	hasTranslatedContent: boolean;
	hasEnglishTitle: boolean;
};

export async function loadResourceTranslationInput(
	db: NodePgDatabase,
	resourceId: string,
): Promise<{ resource: ResourceTranslationInput; textHash: string } | null> {
	// Machine fields are validated before persistence; planning needs their presence, not another copy of the translation.
	const result = await db.execute<ResourceTranslationInput & { textHash: string }>(sql`
		SELECT
			${CANDIDATE_COLUMNS},
			COALESCE(resource.title, '') AS title,
			(SELECT output->>'summary' FROM resource_derivations
			 WHERE resource_id = resource.id AND kind = 'summary' AND lang = 'en' AND status = 'done') AS summary,
			COALESCE(original.markdown, '') AS content,
			zh_hant.output->>'title' IS NOT NULL AS "hasTranslatedTitle",
			zh_hant.output->>'content' IS NOT NULL AS "hasTranslatedContent",
			en.output->>'title' IS NOT NULL AS "hasEnglishTitle"
		FROM resources resource
		LEFT JOIN resource_content original ON original.resource_id = resource.id
		LEFT JOIN resource_derivations zh_hant
		  ON zh_hant.resource_id = resource.id AND zh_hant.kind = 'translation' AND zh_hant.lang = 'zh-Hant' AND zh_hant.status = 'done'
		LEFT JOIN resource_derivations en
		  ON en.resource_id = resource.id AND en.kind = 'translation' AND en.lang = 'en' AND en.status = 'done'
		WHERE resource.id = ${resourceId}::uuid
	`);
	const row = result.rows[0];
	if (!row?.textHash || !isTranslatable(row)) return null;
	const { textHash, ...resource } = row;
	return { resource, textHash };
}

/**
 * Writes a machine translation of the text `textHash` names; false once that text is gone. Machine fields only:
 * alignment is the JSON the content translation compiled, and English is only ever a title.
 */
export async function persistMachineTranslation(
	db: NodePgDatabase,
	resourceId: string,
	textHash: string,
	lang: SummaryLang,
	{ title, content, alignment }: Readonly<{ title?: string; content?: string; alignment?: unknown }>,
): Promise<boolean> {
	// Only onto the text it translated, and never into the original's own language; fields merge, a new text starts over.
	const result = await db.execute<{ resource_id: string }>(sql`
		INSERT INTO resource_derivations AS current (resource_id, kind, lang, input_hash, status, attempts, output, updated_at)
		SELECT resource.id, 'translation', ${lang}, ${textHash}, 'done', 0, jsonb_strip_nulls(jsonb_build_object(
			'title', ${title ?? null}::text, 'content', ${content ?? null}::text,
			'alignment', ${alignment === undefined ? null : JSON.stringify(alignment)}::jsonb
		)), NOW()
		FROM resources resource
		WHERE resource.id = ${resourceId}::uuid AND resource.text_hash = ${textHash} AND resource.original_lang <> ${lang}
		FOR UPDATE OF resource
		ON CONFLICT (resource_id, kind, lang) DO UPDATE SET
			output = CASE WHEN current.input_hash = EXCLUDED.input_hash THEN COALESCE(current.output, '{}'::jsonb) || EXCLUDED.output
			              ELSE EXCLUDED.output END,
			input_hash = EXCLUDED.input_hash, status = 'done', retry_at = NULL, error = NULL, updated_at = NOW()
		RETURNING resource_id::text
	`);
	return result.rows.length > 0;
}

/**
 * Monitor discoveries, and the subjects their carriers point at, translate in full at the operator's cost. Everything
 * else translates its title on admission and its content only when a reader asks for it.
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
 * A stored, translatable Resource: whether its content translates automatically, has a done translation (`hasTranslatedContent`),
 * or has a zh-Hant translation of this text in any state (`translated`).
 */
export async function loadTranslationCandidate(db: NodePgDatabase, resourceId: string): Promise<StoredTranslationCandidate | null> {
	const result = await db.execute<StoredTranslationCandidate>(sql`
		SELECT ${CANDIDATE_COLUMNS},
		       BTRIM(COALESCE(original.markdown, '')) <> '' AS "hasContent",
		       zh_hant.output->>'content' IS NOT NULL AS "hasTranslatedContent",
		       ${AUTOMATIC_CONTENT_TRANSLATION_SQL} AS automatic,
		       EXISTS (
		         SELECT 1 FROM resource_derivations translation
		         WHERE translation.resource_id = resource.id AND translation.kind = 'translation' AND translation.lang = 'zh-Hant'
		           AND translation.input_hash = resource.text_hash
		       ) AS translated
		FROM resources resource
		LEFT JOIN resource_content original ON original.resource_id = resource.id
		LEFT JOIN resource_derivations zh_hant
		  ON zh_hant.resource_id = resource.id AND zh_hant.kind = 'translation' AND zh_hant.lang = 'zh-Hant' AND zh_hant.status = 'done'
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.text_hash IS NOT NULL
	`);
	const row = result.rows[0];
	return row && isTranslatable(row) ? row : null;
}

/**
 * The translations a written original waits for, in the transaction that wrote it: zh-Hant for a title, for content
 * that translates automatically, or to keep one a reader already has of this text; English for a title only.
 */
export async function requiredTranslations(tx: NodePgDatabase, resourceId: string): Promise<Derivation[]> {
	const row = await loadTranslationCandidate(tx, resourceId);
	if (!row) return [];
	const { titled } = RESOURCE_KINDS[row.kind];
	return [
		...(titled || row.automatic || row.translated ? [{ kind: 'translation' as const, lang: 'zh-Hant' as const }] : []),
		...(titled && needsEnglishMetadata(row.originalLang) ? [{ kind: 'translation' as const, lang: 'en' as const }] : []),
	];
}

/**
 * Settles the translations of the text `textHash` names that a run left open: done when it ended with nothing more to
 * write for them, failed with `error` when it threw.
 */
export async function settleOpenTranslations(db: NodePgDatabase, resourceId: string, textHash: string, error: string | null) {
	if (error !== null) {
		for (const lang of ['zh-Hant', 'en'] as const) await failDerivation(db, resourceId, { kind: 'translation', lang }, textHash, error);
		return;
	}
	await db.execute(sql`
		UPDATE resource_derivations SET status = 'done', retry_at = NULL, error = NULL, updated_at = NOW()
		WHERE resource_id = ${resourceId}::uuid AND kind = 'translation' AND input_hash = ${textHash} AND status <> 'done'
	`);
}

/** The states of the translations of the text `textHash` names. */
export async function loadTranslationStates(db: NodePgDatabase, resourceId: string, textHash: string) {
	const { rows } = await db.execute<{ status: 'pending' | 'done' | 'failed' }>(sql`
		SELECT status FROM resource_derivations
		WHERE resource_id = ${resourceId}::uuid AND kind = 'translation' AND input_hash = ${textHash}
	`);
	return rows.map(({ status }) => status);
}
