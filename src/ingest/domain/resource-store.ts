// Read store: canonical resource loading and processability gates for the Workflow.

import { isResourceIdentifierScheme, normalizeResourceIdentifiers, type ResourceIdentifier } from '@core-shared/resource-identifiers';
import {
	parseResourceCreators,
	parseStoredResourceKindMetadata,
	type ResourceCreator,
	type ResourceKindMetadata,
} from '@core-shared/resource-metadata';
import {
	canonicalizeResourceLang,
	isContentResourceKind,
	isResourceSourceSnapshotHash,
	parseResourceIdentity,
	RESOURCE_SCOPES,
	type ResourceIdentity,
	type ResourceScope,
	toResourceIdentityColumns,
} from '@core-shared/resource-types';
import type { ResourceForProcessing } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { resources, sources } from '@db/schema';
import { eq, sql } from 'drizzle-orm';
import { cleanString, dateValue, requiredString } from './resource-values';

export type StoredResourceProcessingInput = {
	resource: ResourceForProcessing;
	isMonitoredOnly: boolean;
	sourceAvatarUrl: string | null;
};

type ResourceStoreRow = {
	id: string;
	source_id: string | null;
	kind: string;
	resource_platform: string | null;
	title: string | null;
	summary: string | null;
	original_lang: string;
	url: string | null;
	source: string | null;
	source_avatar_url: string | null;
	scope: string | null;
	published_date: Date | string | null;
	tags: string[];
	keywords: string[];
	creators: unknown;
	kind_metadata: unknown;
	source_revision: string | null;
	resource_identifiers: unknown;
	is_monitored_only: boolean;
	storage_key: string | null;
	file_type: string | null;
	normalized_url: string | null;
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

function storedResourceSourceRevision(value: unknown, resourceId: string): string {
	if (!isResourceSourceSnapshotHash(value)) throw new Error(`Invalid source_revision for ${resourceId}`);
	return value;
}

export async function loadStoredResourceForProcessing(env: CoreEnv, resourceId: string): Promise<StoredResourceProcessingInput> {
	const row = await withCoreDb(env, (db) => loadStoredResourceRow(db, resourceId));
	return {
		resource: resourceStoreRowToProcessing(row),
		isMonitoredOnly: row.is_monitored_only,
		sourceAvatarUrl: cleanString(row.source_avatar_url),
	};
}

export async function loadSourceAvatarUrl(env: CoreEnv, sourceId: string): Promise<string | null> {
	return withCoreDb(env, async (db) => {
		const row = (await db.select({ avatarUrl: sources.avatarUrl }).from(sources).where(eq(sources.id, sourceId)).limit(1))[0];
		if (!row) throw new Error(`Source ${sourceId} no longer exists`);
		return cleanString(row.avatarUrl);
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

async function loadStoredResourceRow(db: CoreDb, resourceId: string): Promise<ResourceStoreRow> {
	const result = await db.execute<ResourceStoreRow>(sql`
		SELECT
			rl.id::text AS id,
			rl.source_id::text AS source_id,
			rl.kind AS kind,
			rl.resource_platform AS resource_platform,
			rl.title AS title,
			rl.summary AS summary,
			rl.scope = 'corpus'
				AND rl.source_id IS NOT NULL
				AND rl.storage_key IS NULL
				AND NOT EXISTS (SELECT 1 FROM resource_saves save WHERE save.resource_id = rl.id)
				AND NOT EXISTS (SELECT 1 FROM collection_resources edge WHERE edge.resource_id = rl.id)
				AND NOT EXISTS (SELECT 1 FROM workspace_resources edge WHERE edge.resource_id = rl.id)
				AND NOT EXISTS (
					SELECT 1 FROM user_files file
					WHERE file.resource_id = rl.id OR file.canonical_resource_id = rl.id
				)
				AS is_monitored_only,
			rl.original_lang AS original_lang,
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
			CASE WHEN monitored_source.platform = 'youtube' THEN monitored_source.avatar_url END AS source_avatar_url,
			rl.scope AS scope,
			rl.published_date AS published_date,
			rl.tags AS tags,
			rl.keywords AS keywords,
			rl.creators AS creators,
			rl.kind_metadata AS kind_metadata,
			rl.source_revision AS source_revision,
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
	return row;
}

function resourceStoreRowToProcessing(row: ResourceStoreRow): ResourceForProcessing {
	const identity = storedResourceIdentity(row);
	const resourceIdentifiers = resourceIdentifiersValue(row.resource_identifiers);
	return {
		...toResourceIdentityColumns(identity),
		processing_id: row.id,
		source_id: row.source_id,
		original_lang: canonicalizeResourceLang(row.original_lang),
		title: requiredString(row.title, 'title'),
		summary: row.summary,
		content: null,
		url: row.url,
		source: cleanString(row.source),
		published_date: row.published_date === null ? null : dateValue(row.published_date, 'published_date').toISOString(),
		tags: row.tags,
		keywords: row.keywords,
		scope: parseResourceScope(row.scope),
		creators: storedResourceCreatorsValue(row.creators, row.id),
		kind_metadata: storedResourceKindMetadataValue(identity, row.kind_metadata, row.id),
		source_revision: row.source_revision === null ? null : storedResourceSourceRevision(row.source_revision, row.id),
		resource_identifiers: resourceIdentifiers,
		storage_key: row.storage_key,
		file_type: row.file_type,
		normalized_url: row.normalized_url,
	};
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
