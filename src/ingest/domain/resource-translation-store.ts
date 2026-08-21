// Read-side projection for revision-fenced resource translation Workflows.

import {
	canonicalizeResourceLang,
	parseResourceIdentity,
	RESOURCE_TRANSLATION_SOURCES,
	type ResourceTranslationSource,
	toResourceIdentityColumns,
	ZH_HANT_RESOURCE_LANG,
} from '@core-shared/resource-types';
import { withCoreDb } from '@db/client';
import { resourceTranslationIdentityPredicate } from '@db/resource-identity-sql';
import { resources, resourceTranslations } from '@db/schema';
import { type SQL, sql } from 'drizzle-orm';
import { CONTENT_TRANSLATION_MAX_LENGTH, type ResourceTranslationInput } from './resource-translation';
import { cleanString, requiredString } from './resource-values';

const RESOURCE_TRANSLATION_REVISION_RE = /^[0-9a-f]{32}$/;

export function isResourceTranslationRevision(value: unknown): value is string {
	return typeof value === 'string' && RESOURCE_TRANSLATION_REVISION_RE.test(value);
}

function resourceTranslationRevisionSql(input: { content: SQL; lang: SQL; summary: SQL; title: SQL }): SQL {
	return sql`MD5(jsonb_build_array(${input.lang}, ${input.title}, ${input.summary}, ${input.content})::text)`;
}

function eligibleResourceTranslationPredicate(resourceId: string): SQL {
	return sql`${resources.id} = ${resourceId}::uuid
		AND ${resources.scope} = 'corpus'
		AND ${resourceTranslationIdentityPredicate()}
		AND ${resources.url} IS NOT NULL
		AND ${resources.originalLang} <> ${ZH_HANT_RESOURCE_LANG}
		AND NULLIF(BTRIM(original.title), '') IS NOT NULL
		AND NULLIF(BTRIM(original.content), '') IS NOT NULL
		AND length(original.content) <= ${CONTENT_TRANSLATION_MAX_LENGTH}`;
}

export function loadEligibleResourceTranslationRevision(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute<{ source_revision: string }>(sql`
			SELECT ${resourceTranslationRevisionSql({
				content: sql`original.content`,
				lang: sql`original.lang`,
				summary: sql`original.summary`,
				title: sql`original.title`,
			})} AS source_revision
			FROM ${resources}
			JOIN ${resourceTranslations} original
			  ON original.resource_id = ${resources.id}
			 AND original.lang = ${resources.originalLang}
			WHERE ${eligibleResourceTranslationPredicate(resourceId)}
			LIMIT 1
		`);
		return result.rows[0]?.source_revision ?? null;
	});
}

type ResourceTranslationInputRow = {
	id: string;
	kind: string;
	resource_platform: string | null;
	original_lang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	zh_hant_title: string | null;
	zh_hant_summary: string | null;
	zh_hant_content: string | null;
	zh_hant_source: string | null;
	source_revision: string;
};

export function loadEligibleResourceTranslationInput(
	env: CoreEnv,
	resourceId: string,
): Promise<{ resource: ResourceTranslationInput; sourceRevision: string } | null> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute<ResourceTranslationInputRow>(sql`
			SELECT
				${resources.id}::text AS id,
				${resources.kind} AS kind,
				${resources.resourcePlatform} AS resource_platform,
				${resources.originalLang} AS original_lang,
				original.title AS title,
				original.summary AS summary,
				original.content AS content,
				zh_hant.title AS zh_hant_title,
				zh_hant.summary AS zh_hant_summary,
				zh_hant.content AS zh_hant_content,
				zh_hant.source AS zh_hant_source,
				${resourceTranslationRevisionSql({
					content: sql`original.content`,
					lang: sql`original.lang`,
					summary: sql`original.summary`,
					title: sql`original.title`,
				})} AS source_revision
			FROM ${resources}
			JOIN ${resourceTranslations} original
			  ON original.resource_id = ${resources.id}
			 AND original.lang = ${resources.originalLang}
			LEFT JOIN ${resourceTranslations} zh_hant
			  ON zh_hant.resource_id = ${resources.id}
			 AND zh_hant.lang = ${ZH_HANT_RESOURCE_LANG}
			WHERE ${eligibleResourceTranslationPredicate(resourceId)}
			LIMIT 1
		`);
		const row = result.rows[0];
		if (!row) return null;
		const identity = parseResourceIdentity(row.kind, row.resource_platform);
		if (!identity) throw new Error(`Invalid translation resource identity: ${row.kind} / ${String(row.resource_platform)}`);
		if (!isResourceTranslationRevision(row.source_revision)) {
			throw new Error(`Invalid translation source revision for ${resourceId}`);
		}
		const zhHantSource = parseTranslationSource(row.zh_hant_source);
		return {
			resource: {
				...toResourceIdentityColumns(identity),
				id: row.id,
				original_lang: canonicalizeResourceLang(row.original_lang),
				title: requiredString(row.title, 'original translation title'),
				summary: row.summary,
				content: requiredString(row.content, 'original translation content'),
				zhHantTranslation: zhHantSource
					? {
							title: cleanString(row.zh_hant_title),
							summary: cleanString(row.zh_hant_summary),
							content: cleanString(row.zh_hant_content),
							source: zhHantSource,
						}
					: null,
			},
			sourceRevision: row.source_revision,
		};
	});
}

function parseTranslationSource(value: unknown): ResourceTranslationSource | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !(RESOURCE_TRANSLATION_SOURCES as readonly string[]).includes(value)) {
		throw new Error(`Invalid translation source: ${String(value)}`);
	}
	return value as ResourceTranslationSource;
}
