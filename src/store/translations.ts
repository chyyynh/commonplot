import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { PDF_MIME } from '../contracts/pdf-policy';
import { TRANSLATABLE_RESOURCE_KINDS, type ResourceTranslationCandidate } from '../contracts/translation-policy';

export const OriginalHashSchema = z.hash('md5').lowercase();

export type ResourceTranslationInput = ResourceTranslationCandidate & {
	id: string;
	title: string;
	summary: string | null;
	content: string;
	hasTranslatedTitle: boolean;
	hasTranslatedSummary: boolean;
	hasTranslatedContent: boolean;
	translationSource: 'original' | 'machine' | null;
};

const PRIVATE_UPLOADED_PDF_TRANSLATION_SQL = sql`(
	resource.scope = 'private'
	AND resource.kind = 'file'
	AND resource.resource_platform IS NULL
	AND resource.file_type = ${PDF_MIME}
	AND resource.storage_key IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM user_files file
		WHERE file.resource_id = resource.id
	)
)`;

/** Machine fields only; alignment is stored as the JSON the translation compiled. */
export type MachineZhHantTranslationPatch = Readonly<{ title?: string; summary?: string; content?: string; alignment?: unknown }>;

export async function loadResourceTranslationInput(
	db: NodePgDatabase,
	resourceId: string,
): Promise<{ resource: ResourceTranslationInput; originalHash: string } | null> {
	// Machine fields are validated before persistence; planning needs their presence, not another copy of the translation.
	const result = await db.execute<ResourceTranslationInput & { originalHash: string }>(sql`
		SELECT
			resource.file_type AS "fileType",
			resource.id::text AS id,
			resource.kind,
			resource.resource_platform AS "resourcePlatform",
			resource.original_lang AS "originalLang",
			resource.scope,
			COALESCE(original.title, '') AS title,
			original.summary AS summary,
			COALESCE(original.content, '') AS content,
			zh_hant.title IS NOT NULL AS "hasTranslatedTitle",
			zh_hant.summary IS NOT NULL AS "hasTranslatedSummary",
			zh_hant.content IS NOT NULL AS "hasTranslatedContent",
			zh_hant.source AS "translationSource",
			resource.url,
			resource.original_hash AS "originalHash"
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN resource_translations zh_hant
		  ON zh_hant.resource_id = resource.id
		 AND zh_hant.lang = 'zh-Hant'
		WHERE resource.id = ${resourceId}::uuid
		  AND (
			resource.scope = 'corpus'
			OR ${PRIVATE_UPLOADED_PDF_TRANSLATION_SQL}
		  )
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) return null;
	const { originalHash, ...resource } = row;
	return { resource, originalHash: OriginalHashSchema.parse(originalHash) };
}

export async function persistMachineZhHantTranslation(
	db: NodePgDatabase,
	resourceId: string,
	originalHash: string,
	patch: Readonly<MachineZhHantTranslationPatch>,
): Promise<boolean> {
	OriginalHashSchema.parse(originalHash);
	if ((patch.content === undefined) !== (patch.alignment === undefined)) {
		throw new TypeError('Machine translation content and alignment must be persisted together');
	}
	const result = await db.execute<{ resource_id: string }>(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${resourceId}::uuid
			  AND (resource.scope = 'corpus' OR ${PRIVATE_UPLOADED_PDF_TRANSLATION_SQL})
			  AND resource.original_hash = ${originalHash}
			FOR UPDATE OF resource
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, alignment, source, updated_at
		)
		SELECT
			target_resource.id, 'zh-Hant', ${patch.title ?? null}, ${patch.summary ?? null}, ${patch.content ?? null},
			${patch.alignment === undefined ? null : JSON.stringify(patch.alignment)}::jsonb,
			'machine', NOW()
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = COALESCE(EXCLUDED.title, current_translation.title),
			summary = COALESCE(EXCLUDED.summary, current_translation.summary),
			content = COALESCE(EXCLUDED.content, current_translation.content),
			alignment = COALESCE(EXCLUDED.alignment, current_translation.alignment),
			updated_at = NOW()
		WHERE current_translation.source = 'machine'
		RETURNING resource_id::text
	`);
	return result.rows.length > 0;
}

/**
 * Corpus translations that never landed, usually after a burst hit the provider rate limit. Only recent acquisitions
 * qualify: completed attempts stay visible for the Workflow retention window, so a no-op attempt is not repeated.
 */
export async function listMissingTranslations(db: NodePgDatabase, limit: number) {
	const { rows } = await db.execute<{ id: string; originalHash: string }>(sql`
		SELECT resource.id::text, resource.original_hash AS "originalHash"
		FROM resources resource
		JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE resource.scope = 'corpus'
		  AND resource.original_hash IS NOT NULL
		  AND resource.url IS NOT NULL
		  AND resource.original_lang <> 'zh-Hant'
		  AND resource.kind = ANY(${sql.param([...TRANSLATABLE_RESOURCE_KINDS])}::text[])
		  AND resource.scraped_date > now() - interval '6 days'
		  AND resource.scraped_date < now() - interval '15 minutes'
		  AND BTRIM(COALESCE(original.content, '')) <> ''
		  AND NOT EXISTS (
		    SELECT 1 FROM resource_translations translated
		    WHERE translated.resource_id = resource.id AND translated.lang = 'zh-Hant'
		  )
		ORDER BY resource.published_date DESC NULLS LAST
		LIMIT ${limit}
	`);
	return rows;
}
