// Narrow database projections for the two record-first processing paths.

import { normalizePaperIdentifiers, type PaperIdentifier } from '@core-shared/paper-identity';
import type { PdfParseAdmissionSnapshot } from '@core-shared/pdf-parse-contract';
import {
	canonicalizeResourceLang,
	isPaperIdentifier,
	RESOURCE_TYPES,
	type ResourceCreator,
	ResourceCreatorsSchema,
	ResourceIdentifiersSchema,
	type ResourceKindMetadata,
} from '@core-shared/resource';
import { parseExternalHttpUrl } from '@core-shared/url';
import type { CoreDb } from '@db/connection';
import { resourceDisplaySourceSql } from '@db/display-source-sql';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { parsePdfParseAdmission } from '../shared/pdf-parse-contract.ts';
import { parseResourceProcessingWorkflowPayload } from './processing-jobs';

const PENDING_BLOB_GRACE_MS = 10 * 60 * 1000;
const PENDING_BLOB_RECONCILE_LIMIT = 50;
const PENDING_BLOB_RECONCILE_CONCURRENCY = 10;
const STORED_RESOURCE_WORKFLOW_REVISION = 'stored-resource-v10';
const STORED_PDF_WORKFLOW_RETENTION = {
	successRetention: '5 minutes',
	errorRetention: '1 hour',
} as const;

export type StoredPdfInput = {
	contentHash: string;
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
	content_hash: string | null;
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

export type StoredPdfProcessingAdmissionInput = Readonly<{
	resourceId: string;
	parseAdmission: PdfParseAdmissionSnapshot;
}>;

export async function enqueueProcessing(env: CoreEnv, input: StoredPdfProcessingAdmissionInput): Promise<string> {
	const payload = parseResourceProcessingWorkflowPayload({
		target: {
			kind: 'storedBlob',
			resourceId: z.uuid().parse(input.resourceId),
			parseAdmission: input.parseAdmission,
		},
	});
	if (payload.target.kind !== 'storedBlob') throw new Error('Stored PDF processing payload was not preserved');
	const id = `${STORED_RESOURCE_WORKFLOW_REVISION}-${payload.target.parseAdmission.parseRunId}`;
	await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch([{ id, params: payload, retention: STORED_PDF_WORKFLOW_RETENTION }]);
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

type QueuedPdfParseAdmissionRow = {
	resource_id: string;
	parse_run_id: string;
	revision: number;
	input_content_hash: string;
	working_schema_version: number;
	parser_version: string;
	policy_revision: string;
	processing_policy: string;
	entitlement_feature: string | null;
	max_enhanced_pages: number | null;
	max_provider_credits: string | number | null;
	provider_tier: string | null;
	provider_version: string | null;
};

async function claimStalePendingBlobAdmissions(db: CoreDb, olderThan: Date, limit: number): Promise<StoredPdfProcessingAdmissionInput[]> {
	const claimed = await db.execute<QueuedPdfParseAdmissionRow>(sql`
		WITH candidates AS (
			SELECT
			  resource.id,
			  parse_run.id AS parse_run_id,
			  parse_run.revision,
			  parse_run.input_content_hash,
			  parse_run.working_schema_version,
			  parse_run.parser_version,
			  parse_run.policy_revision,
			  parse_run.processing_policy,
			  parse_run.entitlement_feature,
			  parse_run.max_enhanced_pages,
			  parse_run.max_provider_credits,
			  parse_run.provider_tier,
			  parse_run.provider_version
			FROM resources resource
			JOIN LATERAL (
			  SELECT run.*
			  FROM resource_parse_runs run
			  WHERE run.file_resource_id = resource.id
			    AND run.user_file_id IS NOT NULL
			    AND run.retired_at IS NULL
			    AND run.status = 'queued'
			  ORDER BY run.revision DESC
			  LIMIT 1
			) parse_run ON TRUE
			WHERE resource.enrichment_status = 'pending'
			  AND resource.scope = 'private'
			  AND resource.storage_key IS NOT NULL
			  AND EXISTS (
			    SELECT 1
			    FROM user_files
			    WHERE user_files.resource_id = resource.id
			  )
			  AND resource.updated_at < ${olderThan}
			  AND resource.kind NOT IN ('image', 'file')
			ORDER BY resource.updated_at ASC, resource.id ASC
			FOR UPDATE OF resource SKIP LOCKED
			LIMIT ${limit}
		)
		UPDATE resources AS resource
		SET updated_at = NOW()
		FROM candidates
		WHERE resource.id = candidates.id
		RETURNING
		  resource.id::text AS resource_id,
		  candidates.parse_run_id::text AS parse_run_id,
		  candidates.revision,
		  candidates.input_content_hash,
		  candidates.working_schema_version,
		  candidates.parser_version,
		  candidates.policy_revision,
		  candidates.processing_policy,
		  candidates.entitlement_feature,
		  candidates.max_enhanced_pages,
		  candidates.max_provider_credits,
		  candidates.provider_tier,
		  candidates.provider_version
	`);
	return claimed.rows.map((row) => ({
		resourceId: row.resource_id,
		parseAdmission: parsePdfParseAdmission({
			parseRunId: row.parse_run_id,
			fileResourceId: row.resource_id,
			revision: row.revision,
			inputContentHash: row.input_content_hash,
			workingSchemaVersion: row.working_schema_version,
			parserVersion: row.parser_version,
			policyRevision: row.policy_revision,
			processingPolicy: row.processing_policy,
			entitlementFeature: row.entitlement_feature,
			maxEnhancedPages: row.max_enhanced_pages,
			maxProviderCredits: row.max_provider_credits === null ? null : String(row.max_provider_credits),
			providerTier: row.provider_tier,
			providerVersion: row.provider_version,
		}),
	}));
}

/** Repairs only interrupted DB-to-Workflow handoffs for record-first app-owned blobs. */
export async function reconcilePendingBlobProcessing(env: CoreEnv, db: CoreDb): Promise<void> {
	const admissions = await claimStalePendingBlobAdmissions(db, new Date(Date.now() - PENDING_BLOB_GRACE_MS), PENDING_BLOB_RECONCILE_LIMIT);
	if (!admissions.length) return;

	let reconciled = 0;
	let failed = 0;
	for (let offset = 0; offset < admissions.length; offset += PENDING_BLOB_RECONCILE_CONCURRENCY) {
		const batch = admissions.slice(offset, offset + PENDING_BLOB_RECONCILE_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((admission) => enqueueProcessing(env, admission)));
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

export async function loadStoredPdfInput(db: CoreDb, resourceId: string): Promise<StoredPdfInput> {
	const result = await db.execute<StoredPdfRow>(sql`
		SELECT
			resource.id::text AS id,
			resource.content_hash,
			resource.kind,
			original.title,
			original.summary,
			resource.original_lang,
			${resourceDisplaySourceSql({
				creatorName: sql`COALESCE(resource.creators->0->>'literal', CONCAT_WS(' ', resource.creators->0->>'given', resource.creators->0->>'family'))`,
				kind: sql`resource.kind`,
				monitoredSourceName: sql`monitored_source.name`,
				resourcePlatform: sql`resource.resource_platform`,
			})} AS source,
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
	const contentHash = z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.parse(row.content_hash);
	return {
		contentHash,
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

export async function loadResourceReacquisitionInput(db: CoreDb, resourceId: string): Promise<ResourceReacquisitionInput> {
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
	const url = parseExternalHttpUrl(row.url);
	if (!url) throw new Error(`Resource ${resourceId} has no valid external HTTP URL and cannot be reacquired`);
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
