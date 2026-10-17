import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { PDF_MIME } from '../contracts/pdf-policy';
import { RESOURCE_KINDS, type ResourceKind, type ResourcePlatform } from '../contracts/resource';
import { WITHOUT_ENGLISH_METADATA_LANG_PATTERN } from '../contracts/resource-language';
import { kindWhere } from './kind-sql';

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
	translationSource: 'original' | 'machine' | null;
	hasEnglishTitle: boolean;
};

/** Machine fields only; alignment is stored as the JSON the translation compiled. Summaries are derived per language. */
export type MachineZhHantTranslationPatch = Readonly<{ title?: string; content?: string; alignment?: unknown }>;
/** English is only ever a title: recommendation vectors read it, and content stays in its original. */
export type MachineEnglishTranslationPatch = Readonly<{ title?: string }>;

/** A titled Resource whose original is in another named language, so its English title comes from translation. */
const ENGLISH_METADATA_SQL = sql`(${kindWhere(sql`resource.kind`, 'titled')} AND resource.original_lang !~* ${WITHOUT_ENGLISH_METADATA_LANG_PATTERN})`;

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
			CASE WHEN resource.original_lang = 'zh-Hant' THEN 'original' WHEN zh_hant.resource_id IS NOT NULL THEN 'machine' END
				AS "translationSource",
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
	return { resource, textHash: TextHashSchema.parse(textHash) };
}

/** Writes over machine fields only; a row the source supplied in that language is never replaced. */
export async function persistMachineTranslation(
	db: NodePgDatabase,
	resourceId: string,
	textHash: string,
	...[lang, patch]: ['zh-Hant', MachineZhHantTranslationPatch] | ['en', MachineEnglishTranslationPatch]
): Promise<boolean> {
	TextHashSchema.parse(textHash);
	const content = 'content' in patch ? patch.content : undefined;
	const alignment = 'alignment' in patch ? patch.alignment : undefined;
	if ((content === undefined) !== (alignment === undefined)) {
		throw new TypeError('Machine translation content and alignment must be persisted together');
	}
	const result = await db.execute<{ resource_id: string }>(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${resourceId}::uuid
			  AND resource.text_hash = ${textHash}
			FOR UPDATE OF resource
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, alignment, source, updated_at
		)
		SELECT
			target_resource.id, ${lang}, ${patch.title ?? null}, NULL, ${content ?? null},
			${alignment === undefined ? null : JSON.stringify(alignment)}::jsonb,
			'machine', NOW()
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = COALESCE(EXCLUDED.title, current_translation.title),
			content = COALESCE(EXCLUDED.content, current_translation.content),
			alignment = COALESCE(EXCLUDED.alignment, current_translation.alignment),
			updated_at = NOW()
		WHERE current_translation.source = 'machine'
		RETURNING resource_id::text
	`);
	if (!result.rows.length) return false;
	// The same fields as a translation derivation, which replaces resource_translations; a new text starts it over.
	await db.execute(sql`
		INSERT INTO resource_derivations AS current (resource_id, kind, lang, input_hash, status, attempts, output, updated_at)
		VALUES (${resourceId}::uuid, 'translation', ${lang}, ${textHash}, 'done', 0, jsonb_strip_nulls(jsonb_build_object(
			'title', ${patch.title ?? null}::text, 'content', ${content ?? null}::text,
			'alignment', ${alignment === undefined ? null : JSON.stringify(alignment)}::jsonb
		)), NOW())
		ON CONFLICT (resource_id, kind, lang) DO UPDATE SET
			output = CASE WHEN current.input_hash = EXCLUDED.input_hash THEN COALESCE(current.output, '{}'::jsonb) || EXCLUDED.output
			              ELSE EXCLUDED.output END,
			input_hash = EXCLUDED.input_hash, status = 'done', retry_at = NULL, error = NULL, updated_at = NOW()
	`);
	return true;
}

/** A stored corpus original in a language other than zh-Hant that the translation Workflow accepts. */
const TRANSLATABLE_CORPUS_SQL = sql`(
	resource.scope = 'corpus'
	AND resource.text_hash IS NOT NULL
	AND resource.url IS NOT NULL
	AND resource.original_lang <> 'zh-Hant'
	AND ${kindWhere(sql`resource.kind`, 'translatable')}
	AND BTRIM(COALESCE(original.markdown, '')) <> ''
)`;

/**
 * Monitor discoveries, and the subjects their carriers point at, translate in full at the operator's cost. Everything
 * else translates its title on admission and its content only when a reader asks for it.
 */
const AUTOMATIC_CONTENT_TRANSLATION_SQL = sql`(
	(
		resource.source_id IS NOT NULL
		OR EXISTS (SELECT 1 FROM resources carrier WHERE carrier.subject_resource_id = resource.id AND carrier.source_id IS NOT NULL)
	)
	AND COALESCE(LENGTH(original.markdown), 0) <= ${MAX_AUTOMATIC_CONTENT_CHARACTERS}
)`;

export async function translatesContentAutomatically(db: NodePgDatabase, resourceId: string): Promise<boolean> {
	const result = await db.execute<{ automatic: boolean }>(sql`
		SELECT ${AUTOMATIC_CONTENT_TRANSLATION_SQL} AS automatic
		FROM resources resource
		LEFT JOIN resource_content original ON original.resource_id = resource.id
		WHERE resource.id = ${resourceId}::uuid
	`);
	return result.rows[0]?.automatic ?? false;
}

type StoredTranslationCandidate = ResourceTranslationCandidate &
	Readonly<{ id: string; textHash: string; hasContent: boolean; hasTranslatedContent: boolean }>;

/** A stored, translatable Resource as a requested content translation sees it. */
export async function loadTranslationCandidate(db: NodePgDatabase, resourceId: string): Promise<StoredTranslationCandidate | null> {
	const result = await db.execute<StoredTranslationCandidate>(sql`
		SELECT ${CANDIDATE_COLUMNS},
		       BTRIM(COALESCE(original.markdown, '')) <> '' AS "hasContent",
		       zh_hant.output->>'content' IS NOT NULL AS "hasTranslatedContent"
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
 * Corpus translations that never landed, usually after a burst hit the provider rate limit. Only recent acquisitions
 * qualify: completed attempts stay visible for the Workflow retention window, so a no-op attempt is not repeated.
 * Content counts as missing only where it translates automatically; English is only ever a title.
 */
export async function listMissingTranslations(db: NodePgDatabase, limit: number) {
	const { rows } = await db.execute<ResourceTranslationCandidate & { id: string; textHash: string; automaticContent: boolean }>(sql`
		SELECT ${CANDIDATE_COLUMNS},
		       ${AUTOMATIC_CONTENT_TRANSLATION_SQL} AS "automaticContent"
		FROM resources resource
		LEFT JOIN resource_content original ON original.resource_id = resource.id
		LEFT JOIN resource_derivations zh_hant
		  ON zh_hant.resource_id = resource.id AND zh_hant.kind = 'translation' AND zh_hant.lang = 'zh-Hant' AND zh_hant.status = 'done'
		LEFT JOIN resource_derivations en
		  ON en.resource_id = resource.id AND en.kind = 'translation' AND en.lang = 'en' AND en.status = 'done'
		WHERE ${TRANSLATABLE_CORPUS_SQL}
		  AND resource.scraped_date > now() - interval '6 days'
		  AND resource.scraped_date < now() - interval '15 minutes'
		  AND (
		    -- An untitled Resource outside automatic scope has no metadata to translate, so it never gets a zh-Hant row.
		    (zh_hant.resource_id IS NULL AND (${kindWhere(sql`resource.kind`, 'titled')} OR ${AUTOMATIC_CONTENT_TRANSLATION_SQL}))
		    OR (zh_hant.output->>'content' IS NULL AND ${AUTOMATIC_CONTENT_TRANSLATION_SQL})
		    OR (en.resource_id IS NULL AND ${ENGLISH_METADATA_SQL})
		  )
		ORDER BY resource.published_date DESC NULLS LAST
		LIMIT ${limit}
	`);
	return rows;
}
