import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { PDF_MIME } from '../contracts/pdf-policy';
import type { ResourceKind, ResourcePlatform } from '../contracts/resource';
import { WITHOUT_ENGLISH_METADATA_LANG_PATTERN } from '../contracts/resource-language';

export const OriginalHashSchema = z.hash('md5').lowercase();

const TRANSLATABLE_RESOURCE_KINDS = ['blog', 'forum', 'post', 'paper', 'video'] as const;

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
		(TRANSLATABLE_RESOURCE_KINDS as readonly string[]).includes(candidate.kind) &&
		(candidate.fileType !== PDF_MIME || (candidate.kind === 'paper' && candidate.resourcePlatform === null))
	);
}

const CANDIDATE_COLUMNS = sql`resource.id::text, resource.original_hash AS "originalHash", resource.kind, resource.scope, resource.url,
	resource.file_type AS "fileType", resource.resource_platform AS "resourcePlatform", resource.original_lang AS "originalLang"`;

/** Longer automatic translations wait for a reader to request and pay for them. */
const MAX_AUTOMATIC_CONTENT_CHARACTERS = 150_000;

export type ResourceTranslationInput = ResourceTranslationCandidate & {
	id: string;
	title: string;
	summary: string | null;
	content: string;
	hasTranslatedTitle: boolean;
	hasTranslatedSummary: boolean;
	hasTranslatedContent: boolean;
	translationSource: 'original' | 'machine' | null;
	hasEnglishTitle: boolean;
	hasEnglishSummary: boolean;
};

/** Machine fields only; alignment is stored as the JSON the translation compiled. */
export type MachineZhHantTranslationPatch = Readonly<{ title?: string; summary?: string; content?: string; alignment?: unknown }>;
/** English is only ever a title and summary: recommendation vectors read them, and content stays in its original. */
export type MachineEnglishTranslationPatch = Readonly<{ title?: string; summary?: string }>;

/** A non-post whose original is in another named language, so its English title and summary come from translation. */
const ENGLISH_METADATA_SQL = sql`(resource.kind <> 'post' AND resource.original_lang !~* ${WITHOUT_ENGLISH_METADATA_LANG_PATTERN})`;

export async function loadResourceTranslationInput(
	db: NodePgDatabase,
	resourceId: string,
): Promise<{ resource: ResourceTranslationInput; originalHash: string } | null> {
	// Machine fields are validated before persistence; planning needs their presence, not another copy of the translation.
	const result = await db.execute<ResourceTranslationInput & { originalHash: string }>(sql`
		SELECT
			${CANDIDATE_COLUMNS},
			COALESCE(original.title, '') AS title,
			original.summary AS summary,
			COALESCE(original.content, '') AS content,
			zh_hant.title IS NOT NULL AS "hasTranslatedTitle",
			zh_hant.summary IS NOT NULL AS "hasTranslatedSummary",
			zh_hant.content IS NOT NULL AS "hasTranslatedContent",
			zh_hant.source AS "translationSource",
			en.title IS NOT NULL AS "hasEnglishTitle",
			en.summary IS NOT NULL AS "hasEnglishSummary"
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN resource_translations zh_hant
		  ON zh_hant.resource_id = resource.id
		 AND zh_hant.lang = 'zh-Hant'
		LEFT JOIN resource_translations en
		  ON en.resource_id = resource.id
		 AND en.lang = 'en'
		WHERE resource.id = ${resourceId}::uuid
	`);
	const row = result.rows[0];
	if (!row?.originalHash || !isTranslatable(row)) return null;
	const { originalHash, ...resource } = row;
	return { resource, originalHash: OriginalHashSchema.parse(originalHash) };
}

/** Writes over machine fields only; a row the source supplied in that language is never replaced. */
export async function persistMachineTranslation(
	db: NodePgDatabase,
	resourceId: string,
	originalHash: string,
	...[lang, patch]: ['zh-Hant', MachineZhHantTranslationPatch] | ['en', MachineEnglishTranslationPatch]
): Promise<boolean> {
	OriginalHashSchema.parse(originalHash);
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
			  AND resource.original_hash = ${originalHash}
			FOR UPDATE OF resource
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, alignment, source, updated_at
		)
		SELECT
			target_resource.id, ${lang}, ${patch.title ?? null}, ${patch.summary ?? null}, ${content ?? null},
			${alignment === undefined ? null : JSON.stringify(alignment)}::jsonb,
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

/** A stored corpus original in a language other than zh-Hant that the translation Workflow accepts. */
const TRANSLATABLE_CORPUS_SQL = sql`(
	resource.scope = 'corpus'
	AND resource.original_hash IS NOT NULL
	AND resource.url IS NOT NULL
	AND resource.original_lang <> 'zh-Hant'
	AND resource.kind = ANY(${sql.param([...TRANSLATABLE_RESOURCE_KINDS])}::text[])
	AND BTRIM(COALESCE(original.content, '')) <> ''
)`;

/**
 * Monitor discoveries, and the subjects their carriers point at, translate in full at the operator's cost. Everything
 * else translates its title and summary on admission and its content only when a reader asks for it.
 */
const AUTOMATIC_CONTENT_TRANSLATION_SQL = sql`(
	(
		resource.source_id IS NOT NULL
		OR EXISTS (SELECT 1 FROM resources carrier WHERE carrier.subject_resource_id = resource.id AND carrier.source_id IS NOT NULL)
	)
	AND LENGTH(original.content) <= ${MAX_AUTOMATIC_CONTENT_CHARACTERS}
)`;

export async function translatesContentAutomatically(db: NodePgDatabase, resourceId: string): Promise<boolean> {
	const result = await db.execute<{ automatic: boolean }>(sql`
		SELECT ${AUTOMATIC_CONTENT_TRANSLATION_SQL} AS automatic
		FROM resources resource
		JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
	`);
	return result.rows[0]?.automatic ?? false;
}

type StoredTranslationCandidate = ResourceTranslationCandidate &
	Readonly<{ id: string; originalHash: string; hasContent: boolean; hasTranslatedContent: boolean }>;

/** A stored, translatable Resource as a requested content translation sees it. */
export async function loadTranslationCandidate(db: NodePgDatabase, resourceId: string): Promise<StoredTranslationCandidate | null> {
	const result = await db.execute<StoredTranslationCandidate>(sql`
		SELECT ${CANDIDATE_COLUMNS},
		       BTRIM(COALESCE(original.content, '')) <> '' AS "hasContent",
		       zh_hant.content IS NOT NULL AS "hasTranslatedContent"
		FROM resources resource
		JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		LEFT JOIN resource_translations zh_hant ON zh_hant.resource_id = resource.id AND zh_hant.lang = 'zh-Hant'
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.original_hash IS NOT NULL
	`);
	const row = result.rows[0];
	return row && isTranslatable(row) ? row : null;
}

/**
 * Corpus translations that never landed, usually after a burst hit the provider rate limit. Only recent acquisitions
 * qualify: completed attempts stay visible for the Workflow retention window, so a no-op attempt is not repeated.
 * Content counts as missing only where it translates automatically; English is only ever a title and summary.
 */
export async function listMissingTranslations(db: NodePgDatabase, limit: number) {
	const { rows } = await db.execute<ResourceTranslationCandidate & { id: string; originalHash: string; automaticContent: boolean }>(sql`
		SELECT ${CANDIDATE_COLUMNS},
		       ${AUTOMATIC_CONTENT_TRANSLATION_SQL} AS "automaticContent"
		FROM resources resource
		JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		LEFT JOIN resource_translations zh_hant ON zh_hant.resource_id = resource.id AND zh_hant.lang = 'zh-Hant'
		LEFT JOIN resource_translations en ON en.resource_id = resource.id AND en.lang = 'en'
		WHERE ${TRANSLATABLE_CORPUS_SQL}
		  AND resource.scraped_date > now() - interval '6 days'
		  AND resource.scraped_date < now() - interval '15 minutes'
		  AND (
		    zh_hant.resource_id IS NULL
		    OR (zh_hant.content IS NULL AND ${AUTOMATIC_CONTENT_TRANSLATION_SQL})
		    OR (en.resource_id IS NULL AND ${ENGLISH_METADATA_SQL})
		  )
		ORDER BY resource.published_date DESC NULLS LAST
		LIMIT ${limit}
	`);
	return rows;
}
