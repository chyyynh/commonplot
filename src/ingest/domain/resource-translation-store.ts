// resource_translations ownership and revisioned upserts.

import type { ResourceTranslationSource } from '@core-shared/resource-types';
import { type CoreDb, textArraySql } from '@db/client';
import { translatableResourceIdentitySql } from '@db/resource-identity-sql';
import { resources } from '@db/schema';
import { type SQL, sql } from 'drizzle-orm';

export function resourceTranslationIdentityPredicate(): SQL {
	return translatableResourceIdentitySql({
		fileType: sql`${resources.fileType}`,
		kind: sql`${resources.kind}`,
		resourcePlatform: sql`${resources.resourcePlatform}`,
	});
}

type ResourceTranslationWrite = {
	resourceId: string;
	lang: string;
	title?: string | null;
	summary?: string | null;
	content?: string | null;
	keywords?: string[];
	source: ResourceTranslationSource;
	expectedOriginalRevision?: string;
};

const RESOURCE_TRANSLATION_REVISION_RE = /^[0-9a-f]{32}$/;

export function isResourceTranslationRevision(value: unknown): value is string {
	return typeof value === 'string' && RESOURCE_TRANSLATION_REVISION_RE.test(value);
}

export function resourceTranslationRevisionSql(input: { content: SQL; lang: SQL; summary: SQL; title: SQL }): SQL {
	return sql`MD5(jsonb_build_array(${input.lang}, ${input.title}, ${input.summary}, ${input.content})::text)`;
}

/**
 * Row ownership is human > original > machine. Within the winning owner,
 * explicitly supplied fields replace current values; omitted fields are patches.
 */
export async function upsertResourceTranslation(db: CoreDb, input: ResourceTranslationWrite): Promise<boolean> {
	if (input.expectedOriginalRevision && !isResourceTranslationRevision(input.expectedOriginalRevision)) {
		throw new Error('Invalid original resource translation revision');
	}
	const keywords = textArraySql(input.keywords ?? []);
	const sourceRevisionPredicate = input.expectedOriginalRevision
		? sql`
			  AND EXISTS (
				SELECT 1
				FROM resource_translations source_revision
				WHERE source_revision.resource_id = resource.id
				  AND source_revision.lang = resource.original_lang
				  AND ${resourceTranslationRevisionSql({
						content: sql`source_revision.content`,
						lang: sql`source_revision.lang`,
						summary: sql`source_revision.summary`,
						title: sql`source_revision.title`,
					})} = ${input.expectedOriginalRevision}
			  )
		`
		: sql``;
	const preserveCurrent = sql`
		(current_translation.source = 'human' AND excluded.source <> 'human')
		OR (current_translation.source = 'original' AND excluded.source = 'machine')
	`;
	const result = await db.execute(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${input.resourceId}::uuid
			  AND (${input.source} <> 'original' OR resource.original_lang = ${input.lang})
			  ${sourceRevisionPredicate}
			FOR UPDATE OF resource
		), demoted_originals AS (
			UPDATE resource_translations translation
			SET source = 'machine', updated_at = NOW()
			FROM target_resource
			WHERE ${input.source} = 'original'
			  AND translation.resource_id = target_resource.id
			  AND translation.lang <> ${input.lang}
			  AND translation.source = 'original'
			RETURNING translation.resource_id
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, keywords, source
		)
		SELECT
			target_resource.id,
			${input.lang},
			${input.title ?? null},
			${input.summary ?? null},
			${input.content ?? null},
			${keywords},
			${input.source}
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = CASE
				WHEN ${preserveCurrent} OR ${input.title === undefined} THEN current_translation.title
				ELSE excluded.title
			END,
			summary = CASE
				WHEN ${preserveCurrent} OR ${input.summary === undefined} THEN current_translation.summary
				ELSE excluded.summary
			END,
			content = CASE
				WHEN ${preserveCurrent} OR ${input.content === undefined} THEN current_translation.content
				ELSE excluded.content
			END,
			keywords = CASE
				WHEN ${preserveCurrent} OR ${input.keywords === undefined} THEN current_translation.keywords
				ELSE excluded.keywords
			END,
			source = CASE WHEN ${preserveCurrent} THEN current_translation.source ELSE excluded.source END,
			updated_at = NOW()
		RETURNING resource_id::text AS resource_id
	`);
	return result.rows.length > 0;
}
