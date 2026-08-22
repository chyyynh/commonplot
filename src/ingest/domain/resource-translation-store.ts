// Read-side projection for revision-fenced resource translation Workflows.

import {
	canonicalizeResourceLang,
	parseResourceIdentity,
	RESOURCE_TRANSLATION_SOURCES,
	type ResourceTranslationSource,
	toResourceIdentityColumns,
	ZH_HANT_RESOURCE_LANG,
} from '@core-shared/resource-types';
import type { CoreDb } from '@db/connection';
import { sql } from 'drizzle-orm';
import type { ResourceTranslationInput } from './resource-translation';
import { cleanString } from './resource-values';

const RESOURCE_TRANSLATION_REVISION_RE = /^[0-9a-f]{32}$/;

export function isResourceTranslationRevision(value: unknown): value is string {
	return typeof value === 'string' && RESOURCE_TRANSLATION_REVISION_RE.test(value);
}

type ResourceTranslationInputRow = {
	file_type: string | null;
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
	url: string | null;
};

export async function loadResourceTranslationInput(
	db: CoreDb,
	resourceId: string,
): Promise<{ resource: ResourceTranslationInput; sourceRevision: string } | null> {
	const result = await db.execute<ResourceTranslationInputRow>(sql`
		SELECT
			resource.file_type,
			resource.id::text AS id,
			resource.kind,
			resource.resource_platform,
			resource.original_lang,
			original.title AS title,
			original.summary AS summary,
			original.content AS content,
			zh_hant.title AS zh_hant_title,
			zh_hant.summary AS zh_hant_summary,
			zh_hant.content AS zh_hant_content,
			zh_hant.source AS zh_hant_source,
			resource.url,
			MD5(jsonb_build_array(
				original.lang,
				original.title,
				original.summary,
				original.content
			)::text) AS source_revision
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN resource_translations zh_hant
		  ON zh_hant.resource_id = resource.id
		 AND zh_hant.lang = ${ZH_HANT_RESOURCE_LANG}
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'corpus'
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
			file_type: row.file_type,
			id: row.id,
			original_lang: canonicalizeResourceLang(row.original_lang),
			title: row.title ?? '',
			summary: row.summary,
			content: row.content ?? '',
			url: row.url,
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
}

function parseTranslationSource(value: unknown): ResourceTranslationSource | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !(RESOURCE_TRANSLATION_SOURCES as readonly string[]).includes(value)) {
		throw new Error(`Invalid translation source: ${String(value)}`);
	}
	return value as ResourceTranslationSource;
}
