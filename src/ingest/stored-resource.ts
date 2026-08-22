// Narrow database projections for the two record-first processing paths.

import { isResourceIdentifierScheme, normalizeResourceIdentifiers, type ResourceIdentifier } from '@core-shared/resource-identifiers';
import {
	parseResourceCreators,
	parseStoredResourceKindMetadata,
	type ResourceCreator,
	type ResourceKindMetadata,
} from '@core-shared/resource-metadata';
import {
	type ContentResourceIdentity,
	canonicalizeResourceLang,
	isContentResourceIdentity,
	isContentResourceKind,
	isResourceSourceSnapshotHash,
	parseResourceIdentity,
	type ResourceIdentity,
} from '@core-shared/resource-types';
import type { CoreDb } from '@db/connection';
import { resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { sql } from 'drizzle-orm';

type StoredResourceBase = ContentResourceIdentity & {
	resourceId: string;
	originalLang: string;
	summary: string | null;
	url: string | null;
	publishedDate: string | null;
	tags: string[];
	keywords: string[];
	sourceRevision: string | null;
	resourceIdentifiers: ResourceIdentifier[];
	storageKey: string | null;
	normalizedUrl: string | null;
};

export type StoredPdfInput = StoredResourceBase & {
	title: string;
	source: string;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata | null;
	storageKey: string;
	fileType: string;
};

export type ResourceReacquisitionInput = StoredResourceBase & {
	isMonitoredOnly: boolean;
	sourceAvatarUrl: string | null;
	translatePaperUrl: boolean;
};

type StoredResourceIdentityRow = {
	kind: string;
	resource_platform: string | null;
};

type StoredResourceBaseRow = StoredResourceIdentityRow & {
	id: string;
	original_lang: string;
	summary: string | null;
	url: string | null;
	published_date: Date | string | null;
	tags: string[];
	keywords: string[];
	source_revision: string | null;
	resource_identifiers: unknown;
	storage_key: string | null;
	normalized_url: string | null;
};

type StoredPdfRow = StoredResourceBaseRow & {
	title: string | null;
	source: string | null;
	creators: unknown;
	kind_metadata: unknown;
	file_type: string | null;
};

type ResourceReacquisitionRow = StoredResourceBaseRow & {
	is_monitored_only: boolean;
	source_avatar_url: string | null;
	translate_paper_url: boolean;
};

function storedResourceIdentity(row: StoredResourceIdentityRow): ContentResourceIdentity {
	const stored = parseResourceIdentity(row.kind, row.resource_platform);
	if (stored && isContentResourceIdentity(stored)) return stored;
	throw new Error(`Invalid stored resource identity: ${String(row.kind)} / ${String(row.resource_platform)}`);
}

export async function assertResourceProcessable(db: CoreDb, resourceId: string): Promise<void> {
	const result = await db.execute<StoredResourceIdentityRow>(sql`
		SELECT kind, resource_platform
		FROM resources
		WHERE id = ${resourceId}::uuid
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
	const identity = parseResourceIdentity(row.kind, row.resource_platform);
	if (!identity || !isContentResourceKind(identity.kind)) {
		throw new Error(`Resource kind is not processable by core: ${identity?.kind ?? row.kind}`);
	}
}

export async function loadStoredPdfInput(db: CoreDb, resourceId: string): Promise<StoredPdfInput> {
	const result = await db.execute<StoredPdfRow>(sql`
		SELECT
			resource.id::text AS id,
			resource.kind,
			resource.resource_platform,
			original.title,
			original.summary,
			resource.original_lang,
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
				WHERE identifier.resource_id = resource.id
			) AS resource_identifiers,
			resource.url,
			${resourceDisplaySourceSql({
				creatorName: sql`COALESCE(resource.creators->0->>'literal', CONCAT_WS(' ', resource.creators->0->>'given', resource.creators->0->>'family'))`,
				kind: sql`resource.kind`,
				monitoredSourceName: sql`monitored_source.name`,
				resourcePlatform: sql`resource.resource_platform`,
			})} AS source,
			resource.published_date,
			resource.tags,
			original.keywords,
			resource.creators,
			resource.kind_metadata,
			resource.source_revision,
			resource.storage_key,
			resource.file_type,
			resource.normalized_url
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN sources monitored_source ON monitored_source.id = resource.source_id
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.scope = 'private'
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (SELECT 1 FROM user_files file WHERE file.resource_id = resource.id)
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch stored PDF ${resourceId}: not found or not an owned private blob`);
	const base = storedResourceBase(row);
	const title = row.title?.trim();
	const source = row.source?.trim();
	if (!title) throw new Error(`Stored PDF ${resourceId} has no title`);
	if (!source) throw new Error(`Stored PDF ${resourceId} has no source`);
	if (!row.storage_key || !row.file_type) throw new Error(`Stored PDF ${resourceId} has no blob representation`);
	return {
		...base,
		title,
		source,
		creators: storedResourceCreatorsValue(row.creators, resourceId),
		kindMetadata: storedResourceKindMetadataValue(base, row.kind_metadata, resourceId),
		storageKey: row.storage_key,
		fileType: row.file_type,
	};
}

export async function loadResourceReacquisitionInput(db: CoreDb, resourceId: string): Promise<ResourceReacquisitionInput> {
	const result = await db.execute<ResourceReacquisitionRow>(sql`
		SELECT
			resource.id::text AS id,
			resource.kind,
			resource.resource_platform,
			original.summary,
			resource.original_lang,
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
				WHERE identifier.resource_id = resource.id
			) AS resource_identifiers,
			resource.url,
			monitored_source.avatar_url AS source_avatar_url,
			resource.scope = 'corpus'
				AND resource.source_id IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM resource_saves save WHERE save.resource_id = resource.id)
				AND NOT EXISTS (SELECT 1 FROM collection_resources edge WHERE edge.resource_id = resource.id)
				AND NOT EXISTS (SELECT 1 FROM workspace_resources edge WHERE edge.resource_id = resource.id)
				AND NOT EXISTS (
					SELECT 1 FROM user_files file
					WHERE file.resource_id = resource.id OR file.canonical_resource_id = resource.id
				)
				AS is_monitored_only,
			resource.scope = 'corpus' AND resource.source_id IS NULL AS translate_paper_url,
			resource.published_date,
			resource.tags,
			original.keywords,
			resource.source_revision,
			resource.storage_key,
			resource.normalized_url
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		LEFT JOIN sources monitored_source ON monitored_source.id = resource.source_id
		WHERE resource.id = ${resourceId}::uuid
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
	return {
		...storedResourceBase(row),
		isMonitoredOnly: row.is_monitored_only,
		sourceAvatarUrl: row.source_avatar_url?.trim() || null,
		translatePaperUrl: row.translate_paper_url,
	};
}

function storedResourceBase(row: StoredResourceBaseRow): StoredResourceBase {
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new Error('Invalid published_date: expected date');
	return {
		...storedResourceIdentity(row),
		resourceId: row.id,
		originalLang: canonicalizeResourceLang(row.original_lang),
		summary: row.summary,
		url: row.url,
		publishedDate: publishedDate?.toISOString() ?? null,
		tags: row.tags,
		keywords: row.keywords,
		sourceRevision: row.source_revision === null ? null : storedResourceSourceRevision(row.source_revision, row.id),
		resourceIdentifiers: resourceIdentifiersValue(row.resource_identifiers),
		storageKey: row.storage_key,
		normalizedUrl: row.normalized_url,
	};
}

function storedResourceSourceRevision(value: unknown, resourceId: string): string {
	if (!isResourceSourceSnapshotHash(value)) throw new Error(`Invalid source_revision for ${resourceId}`);
	return value;
}

function resourceIdentifiersValue(value: unknown): ResourceIdentifier[] {
	if (!Array.isArray(value)) return [];
	return normalizeResourceIdentifiers(
		value.flatMap((item) => {
			if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
			const identifier = item as Record<string, unknown>;
			if (!isResourceIdentifierScheme(identifier.scheme) || typeof identifier.value !== 'string') return [];
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
