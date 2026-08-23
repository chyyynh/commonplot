// Narrow database projections for the two record-first processing paths.

import { isPaperIdentifierScheme } from '@core-shared/paper-identity';
import {
	canonicalizeResourceLang,
	normalizeResourceIdentifiers,
	parseStoredResourceKindMetadata,
	RESOURCE_TYPES,
	type ResourceCreator,
	ResourceCreatorsSchema,
	type ResourceIdentifier,
	type ResourceIdentifierScheme,
	type ResourceKindMetadata,
} from '@core-shared/resource';
import { parseExternalHttpUrl } from '@core-shared/url';
import type { CoreDb } from '@db/connection';
import { resourceDisplaySourceSql } from '@db/display-source-sql';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const PENDING_BLOB_RECONCILE_CONCURRENCY = 10;
const STORED_RESOURCE_WORKFLOW_REVISION = 'stored-resource-v9';

type StoredResourceBase = {
	resourceId: string;
	originalLang: string;
	summary: string | null;
	url: string | null;
	publishedDate: string | null;
	tags: string[];
	keywords: string[];
	resourceIdentifiers: ResourceIdentifier[];
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

export type ResourceReacquisitionInput = Omit<StoredResourceBase, 'url'> & {
	isMonitoredOnly: boolean;
	sourceAvatarUrl: string | null;
	translatePaperUrl: boolean;
	url: string;
};

type StoredResourceIdentityRow = {
	kind: string;
	resource_platform: string | null;
};

type ResourceProcessableRow = StoredResourceIdentityRow & { url: string | null };

type StoredResourceBaseRow = StoredResourceIdentityRow & {
	id: string;
	original_lang: string;
	summary: string | null;
	url: string | null;
	published_date: Date | string | null;
	tags: string[];
	keywords: string[];
	resource_identifiers: unknown;
	normalized_url: string | null;
};

type StoredPdfRow = StoredResourceBaseRow & {
	title: string | null;
	source: string | null;
	creators: unknown;
	kind_metadata: unknown;
	file_type: string | null;
	storage_key: string | null;
};

type ResourceReacquisitionRow = StoredResourceBaseRow & {
	is_monitored_only: boolean;
	source_avatar_url: string | null;
	translate_paper_url: boolean;
};

export async function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	const resourceIdValue = z.uuid().parse(resourceId);
	const id = `${STORED_RESOURCE_WORKFLOW_REVISION}-${resourceIdValue}`;
	await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: { target: { kind: 'storedBlob', resourceId: resourceIdValue } } }]);
	return id;
}

export async function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	const id = z.uuid().parse(resourceId);
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
		id: `resource-resync-v3-${id}-${crypto.randomUUID()}`,
		params: { target: { kind: 'reacquire', resourceId: id } },
	});
	return instance.id;
}

export async function markStoredBlobProcessingFailed(db: CoreDb, resourceId: string): Promise<void> {
	await db.execute(sql`
		UPDATE resources AS resource
		SET enrichment_status = 'failed',
		    updated_at = NOW()
		WHERE resource.id = ${resourceId}::uuid
		  AND resource.enrichment_status <> 'enriched'
		  AND resource.scope = 'private'
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (
		    SELECT 1
		    FROM user_files
		    WHERE user_files.resource_id = resource.id
		  )
	`);
}

async function claimStalePendingBlobAdmissions(db: CoreDb, olderThan: Date, limit: number): Promise<Array<{ resourceId: string }>> {
	const claimed = await db.execute<{ resource_id: string }>(sql`
		WITH candidates AS (
			SELECT id
			FROM resources
			WHERE enrichment_status = 'pending'
			  AND scope = 'private'
			  AND storage_key IS NOT NULL
			  AND EXISTS (
			    SELECT 1
			    FROM user_files
			    WHERE user_files.resource_id = resources.id
			  )
			  AND updated_at < ${olderThan}
			  AND ${inArray(sql`kind`, RESOURCE_TYPES.kinds.exclude(['image', 'file']).options)}
			ORDER BY updated_at ASC, id ASC
			FOR UPDATE SKIP LOCKED
			LIMIT ${limit}
		)
		UPDATE resources AS resource
		SET updated_at = NOW()
		FROM candidates
		WHERE resource.id = candidates.id
		RETURNING resource.id::text AS resource_id
	`);
	return claimed.rows.map(({ resource_id }) => ({ resourceId: resource_id }));
}

/** Repairs only interrupted DB-to-Workflow handoffs for record-first app-owned blobs. */
export async function reconcilePendingBlobProcessing(env: CoreEnv, db: CoreDb): Promise<void> {
	const admissions = await claimStalePendingBlobAdmissions(db, new Date(Date.now() - PENDING_BLOB_GRACE_MS), PENDING_BLOB_RECONCILE_LIMIT);
	if (!admissions.length) return;

	let reconciled = 0;
	let failed = 0;
	for (let offset = 0; offset < admissions.length; offset += PENDING_BLOB_RECONCILE_CONCURRENCY) {
		const batch = admissions.slice(offset, offset + PENDING_BLOB_RECONCILE_CONCURRENCY);
		const results = await Promise.allSettled(batch.map(({ resourceId }) => enqueueProcessing(env, resourceId)));
		for (const [index, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				reconciled++;
				continue;
			}
			failed++;
			console.error({
				tag: 'RESOURCE_WORKFLOW',
				event: 'pending_blob_reconciliation_failed',
				resource_id: batch[index]?.resourceId,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'pending_blob_reconciliation_completed',
		attempted: admissions.length,
		reconciled,
		failed,
	});
}

export async function assertResourceProcessable(db: CoreDb, resourceId: string): Promise<void> {
	const result = await db.execute<ResourceProcessableRow>(sql`
		SELECT kind, resource_platform, url
		FROM resources
		WHERE id = ${resourceId}::uuid
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
	const identity = RESOURCE_TYPES.identity.safeParse({ kind: row.kind, resourcePlatform: row.resource_platform });
	if (!identity.success || !RESOURCE_TYPES.kinds.exclude(['image', 'file']).safeParse(identity.data.kind).success) {
		throw new Error(`Resource kind is not processable by core: ${identity.success ? identity.data.kind : row.kind}`);
	}
	if (!parseExternalHttpUrl(row.url)) throw new Error(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
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
	const identity = RESOURCE_TYPES.identity.parse({ kind: row.kind, resourcePlatform: row.resource_platform });
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
		kindMetadata: storedResourceKindMetadataValue(identity, row.kind_metadata, resourceId),
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
	RESOURCE_TYPES.identity.parse({ kind: row.kind, resourcePlatform: row.resource_platform });
	const base = storedResourceBase(row);
	const url = parseExternalHttpUrl(base.url);
	if (!url) throw new Error(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	return {
		...base,
		url: url.toString(),
		isMonitoredOnly: row.is_monitored_only,
		sourceAvatarUrl: row.source_avatar_url?.trim() || null,
		translatePaperUrl: row.translate_paper_url,
	};
}

function storedResourceBase(row: StoredResourceBaseRow): StoredResourceBase {
	const publishedDate = row.published_date instanceof Date ? row.published_date : row.published_date ? new Date(row.published_date) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new Error('Invalid published_date: expected date');
	return {
		resourceId: row.id,
		originalLang: canonicalizeResourceLang(row.original_lang),
		summary: row.summary,
		url: row.url,
		publishedDate: publishedDate?.toISOString() ?? null,
		tags: row.tags,
		keywords: row.keywords,
		resourceIdentifiers: resourceIdentifiersValue(row.resource_identifiers),
		normalizedUrl: row.normalized_url,
	};
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

function isResourceIdentifierScheme(value: unknown): value is ResourceIdentifierScheme {
	return isPaperIdentifierScheme(value) || (typeof value === 'string' && Object.hasOwn(RESOURCE_TYPES.platformKinds, value));
}

function storedResourceCreatorsValue(value: unknown, resourceId: string): ResourceCreator[] {
	try {
		return ResourceCreatorsSchema.parse(value);
	} catch (error) {
		throw new Error(`Invalid creators for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function emptyStoredResourceKindMetadata(identity: z.infer<typeof RESOURCE_TYPES.identity>): ResourceKindMetadata | null {
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

function storedResourceKindMetadataValue(
	identity: z.infer<typeof RESOURCE_TYPES.identity>,
	value: unknown,
	resourceId: string,
): ResourceKindMetadata | null {
	if (value === null || value === undefined) return emptyStoredResourceKindMetadata(identity);
	try {
		return parseStoredResourceKindMetadata(identity.kind, value);
	} catch (error) {
		throw new Error(`Invalid kind_metadata for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
