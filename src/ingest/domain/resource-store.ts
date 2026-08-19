// Read store: canonical resource loading and processability gates for the Workflow.

import { normalizePaperIdentifiers, type PaperIdentifier } from '@core-shared/paper-identity';
import {
	isPaperIdentifier,
	isResourceIdentifierScheme,
	normalizeResourceIdentifiers,
	type ResourceIdentifier,
} from '@core-shared/resource-identifiers';
import {
	parseResourceCreators,
	parseStoredResourceKindMetadata,
	type ResourceCreator,
	type ResourceKindMetadata,
} from '@core-shared/resource-metadata';
import {
	canonicalizeResourceLang,
	isContentResourceKind,
	parseResourceIdentity,
	RESOURCE_SCOPES,
	RESOURCE_TRANSLATION_SOURCES,
	type ResourceIdentity,
	type ResourcePlatform,
	type ResourceScope,
	type ResourceTranslationSource,
	type SourceAcquisitionMode,
	toResourceIdentityColumns,
} from '@core-shared/resource-types';
import type { ResourceForProcessing, ResourceLocaleText, ResourceTranslationMap } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { resourceIdentifiers, resources, resourceTranslations, youtubeTranscripts } from '@db/schema';
import { eq, type SQL, sql } from 'drizzle-orm';
import { resourceTranslationIdentityPredicate } from './resource-translation-store';
import { cleanString, dateValue, requiredString, storedResourceSourceRevision, stringArrayValue } from './resource-values';

type StoredResourceForProcessing = ResourceForProcessing & {
	has_content?: boolean;
	has_youtube_transcript?: boolean;
};

type ResourceStoreRow = {
	id: string;
	source_id: string | null;
	source_acquisition_mode: string | null;
	kind: string;
	resource_platform: string | null;
	title: string | null;
	summary: string | null;
	content: string | null;
	original_lang: string;
	translations: unknown;
	url: string | null;
	source: string | null;
	scope: string | null;
	enrichment_status: string;
	published_date: Date | string | null;
	scraped_date: Date | string | null;
	updated_at: Date | string;
	created_at: Date | string;
	tags: string[];
	keywords: string[];
	creators: unknown;
	kind_metadata: unknown;
	source_revision: string | null;
	subject_resource_id: string | null;
	resource_identifiers: unknown;
	has_content?: boolean;
	has_youtube_transcript?: boolean;
	storage_key?: string | null;
	file_type?: string | null;
	normalized_url?: string | null;
};

type ResourceStoreTranslationRow = {
	lang?: unknown;
	title?: unknown;
	summary?: unknown;
	content?: unknown;
	keywords?: unknown;
	source?: unknown;
};

type StoredResourceIdentityRow = {
	kind: string;
	resource_platform: string | null;
};

function storedResourceIdentity(row: StoredResourceIdentityRow) {
	const stored = parseResourceIdentity(row.kind, row.resource_platform);
	if (stored) return stored;
	throw new Error(`Invalid stored resource identity: ${String(row.kind)} / ${String(row.resource_platform)}`);
}

function parseSourceAcquisitionMode(value: unknown): SourceAcquisitionMode | null {
	if (value === null || value === undefined) return null;
	if (value === 'platform' || value === 'web' || value === 'feed') return value;
	throw new Error(`Invalid source acquisition mode: ${String(value)}`);
}

function effectiveResourcePlatformPredicate(platform: Exclude<ResourcePlatform, null>): SQL {
	return sql`${resources.resourcePlatform} = ${platform}`;
}

export async function loadResourceForProcessing(env: CoreEnv, resourceId: string): Promise<StoredResourceForProcessing> {
	return withCoreDb(env, (db) => loadResourceForProcessingFromDb(db, resourceId));
}

export async function loadResourceShellForProcessing(env: CoreEnv, resourceId: string): Promise<StoredResourceForProcessing> {
	return withCoreDb(env, (db) => loadStoredResourceRow(db, resourceId, true));
}

export function loadResourceForProcessingFromDb(db: CoreDb, resourceId: string): Promise<StoredResourceForProcessing> {
	return loadStoredResourceRow(db, resourceId, false);
}

export async function isResourceEnrichmentComplete(env: CoreEnv, resourceId: string): Promise<boolean> {
	return withCoreDb(env, async (db) => {
		const row = (
			await db
				.select({
					kind: resources.kind,
					resourcePlatform: resources.resourcePlatform,
					complete: sql<boolean>`${resources.enrichmentStatus} = 'enriched'
								AND (
									NOT (${effectiveResourcePlatformPredicate('youtube')})
									OR EXISTS (
										SELECT 1
										FROM ${youtubeTranscripts}
										JOIN ${resourceIdentifiers} identifier
										  ON identifier.resource_id = ${resources.id}
										 AND identifier.scheme = 'youtube'
										 AND identifier.value = ${youtubeTranscripts.videoId}
									)
								)
								AND EXISTS (
									SELECT 1
									FROM ${resourceTranslations} original
									WHERE original.resource_id = ${resources.id}
									  AND original.lang = ${resources.originalLang}
									  AND NULLIF(BTRIM(original.title), '') IS NOT NULL
									  AND (
										${resources.scope} <> 'corpus'
										OR NOT (${resourceTranslationIdentityPredicate()})
										OR ${resources.url} IS NULL
										OR (
											NULLIF(BTRIM(original.content), '') IS NOT NULL
										)
									  )
								)`,
				})
				.from(resources)
				.where(eq(resources.id, resourceId))
				.limit(1)
		)[0];
		if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
		const identity = storedResourceIdentity({
			kind: row.kind,
			resource_platform: row.resourcePlatform,
		});
		if (!isContentResourceKind(identity.kind)) {
			throw new Error(`Resource kind is not processable by core: ${identity.kind}`);
		}
		return row.complete;
	});
}

export async function assertResourceProcessable(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		const row = (
			await db
				.select({
					kind: resources.kind,
					resourcePlatform: resources.resourcePlatform,
				})
				.from(resources)
				.where(eq(resources.id, resourceId))
				.limit(1)
		)[0];
		if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
		const identity = storedResourceIdentity({
			kind: row.kind,
			resource_platform: row.resourcePlatform,
		});
		if (!isContentResourceKind(identity.kind)) {
			throw new Error(`Resource kind is not processable by core: ${identity.kind}`);
		}
	});
}

async function loadStoredResourceRow(db: CoreDb, resourceId: string, shell: boolean): Promise<StoredResourceForProcessing> {
	const result = await db.execute<ResourceStoreRow>(sql`
		SELECT
			rl.id::text AS id,
			rl.source_id::text AS source_id,
			monitored_source.content_mode AS source_acquisition_mode,
			rl.kind AS kind,
			rl.resource_platform AS resource_platform,
			rl.title AS title,
			rl.summary AS summary,
			${shell ? sql`NULL::text` : sql`rl.content`} AS content,
			${shell ? sql`rl.content IS NOT NULL AND length(rl.content) > 0` : sql`NULL::boolean`} AS has_content,
			${
				shell
					? sql`CASE
						WHEN rl.resource_platform = 'youtube' THEN EXISTS (
							SELECT 1
							FROM ${youtubeTranscripts}
							JOIN resource_identifiers identifier
							  ON identifier.resource_id = rl.id
							 AND identifier.scheme = 'youtube'
							 AND identifier.value = ${youtubeTranscripts.videoId}
						)
						ELSE NULL
					END`
					: sql`NULL::boolean`
			} AS has_youtube_transcript,
			rl.original_lang AS original_lang,
			(
				SELECT jsonb_agg(
					jsonb_build_object(
						'lang', rt.lang,
						'title', rt.title,
						'summary', rt.summary,
						'content', ${shell ? sql`NULL::text` : sql`rt.content`},
						'keywords', rt.keywords,
						'source', rt.source
					)
					ORDER BY (rt.lang = rl.original_lang) DESC, rt.lang ASC
				)
				FROM resource_translations rt
				WHERE rt.resource_id = rl.id
			) AS translations,
			(
				SELECT jsonb_agg(
					jsonb_build_object(
						'preferred', identifier.is_preferred,
						'scheme', identifier.scheme,
						'value', identifier.value
					)
					ORDER BY identifier.scheme, identifier.is_preferred DESC, identifier.value
				)
				FROM resource_identifiers identifier
				WHERE identifier.resource_id = rl.id
			) AS resource_identifiers,
			rl.url AS url,
			${resourceDisplaySourceSql({
				creatorName: sql`COALESCE(rl.creators->0->>'literal', CONCAT_WS(' ', rl.creators->0->>'given', rl.creators->0->>'family'))`,
				kind: sql`rl.kind`,
				monitoredSourceName: sql`monitored_source.name`,
				resourcePlatform: sql`rl.resource_platform`,
			})} AS source,
			rl.scope AS scope,
			rl.enrichment_status AS enrichment_status,
			rl.published_date AS published_date,
			rl.scraped_date AS scraped_date,
			rl.updated_at AS updated_at,
			rl.created_at AS created_at,
			rl.tags AS tags,
			rl.keywords AS keywords,
			rl.creators AS creators,
			rl.kind_metadata AS kind_metadata,
			rl.source_revision AS source_revision,
			rl.subject_resource_id::text AS subject_resource_id,
			rl.storage_key AS storage_key,
			rl.file_type AS file_type,
			rl.normalized_url AS normalized_url
		FROM resources_localized rl
		LEFT JOIN sources monitored_source ON monitored_source.id = rl.source_id
		WHERE rl.id = ${resourceId}::uuid
		  AND rl.lang = rl.original_lang
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
	return resourceStoreRowToProcessing(row);
}

function resourceStoreRowToProcessing(row: ResourceStoreRow): StoredResourceForProcessing {
	const identity = storedResourceIdentity(row);
	const resource: StoredResourceForProcessing = {
		...toResourceIdentityColumns(identity),
		id: row.id,
		source_id: row.source_id,
		source_acquisition_mode: parseSourceAcquisitionMode(row.source_acquisition_mode),
		original_lang: canonicalizeResourceLang(row.original_lang),
		title: requiredString(row.title, 'title'),
		summary: row.summary,
		content: row.content,
		translations: resourceStoreTranslations(row),
		url: row.url,
		source: cleanString(row.source),
		published_date: row.published_date === null ? null : dateValue(row.published_date, 'published_date').toISOString(),
		tags: row.tags,
		keywords: row.keywords,
		scope: parseResourceScope(row.scope),
		creators: storedResourceCreatorsValue(row.creators, row.id),
		kind_metadata: storedResourceKindMetadataValue(identity, row.kind_metadata, row.id),
		source_revision: row.source_revision === null ? null : storedResourceSourceRevision(row.source_revision, row.id),
		subject_resource_id: row.subject_resource_id,
		resource_identifiers: resourceIdentifiersValue(row.resource_identifiers),
		paper_identifiers: paperIdentifiersValue(row.resource_identifiers),
	};
	if (typeof row.has_content === 'boolean') resource.has_content = row.has_content;
	if (typeof row.has_youtube_transcript === 'boolean') resource.has_youtube_transcript = row.has_youtube_transcript;
	resource.storage_key = row.storage_key ?? null;
	if (row.file_type) resource.file_type = row.file_type;
	resource.normalized_url = row.normalized_url ?? null;
	return resource;
}

function paperIdentifiersValue(value: unknown): PaperIdentifier[] {
	return normalizePaperIdentifiers(resourceIdentifiersValue(value).filter(isPaperIdentifier));
}

function resourceIdentifiersValue(value: unknown): ResourceIdentifier[] {
	if (!Array.isArray(value)) return [];
	return normalizeResourceIdentifiers(
		value.flatMap((item) => {
			if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
			const identifier = item as Record<string, unknown>;
			if (!isResourceIdentifierScheme(identifier.scheme) || typeof identifier.value !== 'string') {
				return [];
			}
			return [{ preferred: identifier.preferred !== false, scheme: identifier.scheme, value: identifier.value }];
		}),
	);
}

function resourceStoreTranslations(row: ResourceStoreRow): ResourceTranslationMap {
	const map: ResourceTranslationMap = {};
	if (!Array.isArray(row.translations)) throw new Error(`Invalid translations for resource ${row.id}: expected array`);
	for (const item of row.translations) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new Error(`Invalid translation for resource ${row.id}: expected object`);
		}
		const translation = item as ResourceStoreTranslationRow;
		const lang = canonicalizeResourceLang(translation.lang);
		const compact = compactLocaleText({
			title: translation.title as ResourceLocaleText['title'],
			summary: translation.summary as ResourceLocaleText['summary'],
			content: translation.content as ResourceLocaleText['content'],
			keywords: stringArrayValue(translation.keywords, 'translation keywords'),
			source: translation.source as ResourceLocaleText['source'],
		});
		if (compact) map[lang] = compact;
	}
	return map;
}

function compactLocaleText(value: ResourceLocaleText): ResourceLocaleText | null {
	const title = cleanString(value.title);
	const summary = cleanString(value.summary);
	const content = cleanString(value.content);
	const keywords =
		value.keywords === null || value.keywords === undefined ? null : stringArrayValue(value.keywords, 'translation keywords');
	const source = parseTranslationSource(value.source);
	if (!title && !summary && !content && !keywords?.length) return null;
	return {
		...(title ? { title } : {}),
		...(summary ? { summary } : {}),
		...(content ? { content } : {}),
		...(keywords?.length ? { keywords } : {}),
		...(source ? { source } : {}),
	};
}

function storedResourceCreatorsValue(value: unknown, resourceId: string): ResourceCreator[] {
	try {
		return parseResourceCreators(value);
	} catch (error) {
		throw new Error(`Invalid creators for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function emptyStoredResourceKindMetadata(identity: ResourceIdentity): ResourceKindMetadata | null {
	switch (identity.kind) {
		case 'blog':
		case 'image':
		case 'file':
			return null;
		case 'forum':
		case 'video':
		case 'paper':
			return {};
		case 'post':
			return { attachments: [] };
	}
}

function storedResourceKindMetadataValue(identity: ResourceIdentity, value: unknown, resourceId: string): ResourceKindMetadata | null {
	if (value === null || value === undefined) return emptyStoredResourceKindMetadata(identity);
	try {
		return parseStoredResourceKindMetadata(identity.kind, value);
	} catch (error) {
		throw new Error(`Invalid kind_metadata for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseResourceScope(value: unknown): ResourceScope {
	if (typeof value !== 'string' || !(RESOURCE_SCOPES as readonly string[]).includes(value)) {
		throw new Error(`Invalid resource scope: ${String(value)}`);
	}
	return value as ResourceScope;
}

function parseTranslationSource(value: unknown): ResourceTranslationSource | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !(RESOURCE_TRANSLATION_SOURCES as readonly string[]).includes(value)) {
		throw new Error(`Invalid translation source: ${String(value)}`);
	}
	return value as ResourceTranslationSource;
}
