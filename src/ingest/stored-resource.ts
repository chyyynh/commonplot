// Narrow database projections for the two record-first processing paths.

import { normalizePaperIdentifiers, type PaperIdentifier } from '@core-shared/paper-identity';
import {
	canonicalizeResourceLang,
	isPaperIdentifier,
	RESOURCE_TYPES,
	type ResourceCreator,
	ResourceCreatorsSchema,
	ResourceIdentifiersSchema,
	type ResourceKindMetadata,
} from '@core-shared/resource';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const STORED_RESOURCE_WORKFLOW_REVISION = 'stored-resource-v11';
const STORED_PDF_WORKFLOW_RETENTION = {
	successRetention: '5 minutes',
	errorRetention: '1 hour',
} as const;

export type StoredPdfInput = {
	creators: ResourceCreator[];
	fileType: string;
	kindMetadata: ResourceKindMetadata | null;
	originalLang: string;
	publishedDate: string | null;
	resourceId: string;
	source: string;
	storageKey: string;
	summary: string | null;
	title: string;
};

export type ResourceReacquisitionInput = {
	originalLang: string;
	paperIdentifiers: PaperIdentifier[];
	publishedDate: string | null;
	summary: string | null;
	url: string;
};

type StoredPdfRow = {
	creators: unknown;
	file_type: string | null;
	id: string;
	kind: keyof typeof RESOURCE_TYPES;
	kind_metadata: unknown;
	original_lang: string;
	published_date: Date | string | null;
	source: string | null;
	storage_key: string | null;
	summary: string | null;
	title: string | null;
};

type ResourceReacquisitionRow = {
	original_lang: string;
	published_date: Date | string | null;
	resource_identifiers: unknown;
	summary: string | null;
	url: string | null;
};

export type StoredPdfProcessingInput = Readonly<{
	resourceId: string;
}>;

function storedPdfWorkflowInstance(resourceId: string) {
	const id = z.uuid().parse(resourceId);
	return {
		id: `${STORED_RESOURCE_WORKFLOW_REVISION}-${id}`,
		params: { kind: 'storedBlob' as const, resourceId: id },
		retention: STORED_PDF_WORKFLOW_RETENTION,
	};
}

export async function enqueueProcessing(env: CoreEnv, input: StoredPdfProcessingInput): Promise<string> {
	const instance = storedPdfWorkflowInstance(input.resourceId);
	await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([instance]);
	return instance.id;
}

export async function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	const id = z.uuid().parse(resourceId);
	const instance = await env.RESOURCE_PROCESSING_V2_WORKFLOW.create({
		id: `resource-resync-v3-${id}-${crypto.randomUUID()}`,
		params: { kind: 'reacquire', resourceId: id },
	});
	return instance.id;
}

export async function markStoredBlobProcessingFailed(db: NodePgDatabase, resourceId: string): Promise<void> {
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

type PendingBlobRow = {
	resource_id: string;
};

async function stalePendingBlobResourceIds(db: NodePgDatabase, olderThan: Date, limit: number): Promise<string[]> {
	const result = await db.execute<PendingBlobRow>(sql`
		SELECT resource.id::text AS resource_id
		FROM resources resource
		WHERE resource.enrichment_status = 'pending'
		  AND resource.scope = 'private'
		  AND resource.kind = 'blog'
		  AND resource.resource_platform IS NULL
		  AND resource.file_type = 'application/pdf'
		  AND resource.storage_key IS NOT NULL
		  AND EXISTS (
		    SELECT 1
		    FROM user_files
		    WHERE user_files.resource_id = resource.id
		  )
		  AND resource.updated_at < ${olderThan}
		ORDER BY resource.updated_at ASC, resource.id ASC
		LIMIT ${limit}
	`);
	return result.rows.map((row) => row.resource_id);
}

/** Repairs only interrupted DB-to-Workflow handoffs for record-first app-owned blobs. */
export async function reconcilePendingBlobProcessing(env: CoreEnv, db: NodePgDatabase): Promise<void> {
	const resourceIds = await stalePendingBlobResourceIds(db, new Date(Date.now() - PENDING_BLOB_GRACE_MS), PENDING_BLOB_RECONCILE_LIMIT);
	if (!resourceIds.length) return;
	const created = await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(resourceIds.map(storedPdfWorkflowInstance));
	console.info({
		tag: 'RESOURCE_WORKFLOW',
		event: 'pending_blob_reconciliation_completed',
		attempted: resourceIds.length,
		created: created.length,
		existing: resourceIds.length - created.length,
	});
}

export async function loadStoredPdfInput(db: NodePgDatabase, resourceId: string): Promise<StoredPdfInput> {
	const result = await db.execute<StoredPdfRow>(sql`
		SELECT
			resource.id::text AS id,
			resource.kind,
			original.title,
			original.summary,
			resource.original_lang,
			COALESCE(
				NULLIF(BTRIM(monitored_source.name), ''),
				NULLIF(BTRIM(COALESCE(
					resource.creators->0->>'literal',
					CONCAT_WS(' ', resource.creators->0->>'given', resource.creators->0->>'family')
				)), ''),
				CASE resource.resource_platform
					WHEN 'twitter' THEN 'Twitter'
					WHEN 'youtube' THEN 'YouTube'
					WHEN 'hackernews' THEN 'Hacker News'
					WHEN 'lesswrong' THEN 'LessWrong'
				END,
				INITCAP(resource.kind)
			) AS source,
			resource.published_date,
			resource.creators,
			resource.kind_metadata,
			resource.storage_key,
			resource.file_type
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
	const title = row.title?.trim();
	const source = row.source?.trim();
	if (!title) throw new Error(`Stored PDF ${resourceId} has no title`);
	if (!source) throw new Error(`Stored PDF ${resourceId} has no source`);
	if (!row.storage_key || !row.file_type) throw new Error(`Stored PDF ${resourceId} has no blob representation`);
	return {
		creators: storedResourceCreatorsValue(row.creators, resourceId),
		fileType: row.file_type,
		kindMetadata: RESOURCE_TYPES[row.kind].metadata.parse(row.kind_metadata),
		originalLang: canonicalizeResourceLang(row.original_lang),
		publishedDate: storedPublishedDate(row.published_date),
		resourceId: row.id,
		source,
		storageKey: row.storage_key,
		summary: row.summary,
		title,
	};
}

export async function loadResourceReacquisitionInput(db: NodePgDatabase, resourceId: string): Promise<ResourceReacquisitionInput> {
	const result = await db.execute<ResourceReacquisitionRow>(sql`
		SELECT
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
				  AND identifier.scheme IN ('doi', 'arxiv', 'openalex')
			) AS resource_identifiers,
			resource.url,
			resource.published_date
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid
		LIMIT 1
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
	const url = row.url ? URL.parse(row.url) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
		throw new Error(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
	}
	return {
		originalLang: canonicalizeResourceLang(row.original_lang),
		paperIdentifiers: normalizePaperIdentifiers(ResourceIdentifiersSchema.parse(row.resource_identifiers ?? []).filter(isPaperIdentifier)),
		publishedDate: storedPublishedDate(row.published_date),
		summary: row.summary,
		url: url.toString(),
	};
}

function storedPublishedDate(value: Date | string | null): string | null {
	const publishedDate = value instanceof Date ? value : value ? new Date(value) : null;
	if (publishedDate && !Number.isFinite(publishedDate.getTime())) throw new Error('Invalid published_date: expected date');
	return publishedDate?.toISOString() ?? null;
}

function storedResourceCreatorsValue(value: unknown, resourceId: string): ResourceCreator[] {
	try {
		return ResourceCreatorsSchema.parse(value);
	} catch (error) {
		throw new Error(`Invalid creators for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
