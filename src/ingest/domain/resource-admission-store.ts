import {
	type ContentResourceIdentity,
	canonicalizeOptionalResourceLang,
	DEFAULT_RESOURCE_LANG,
	isContentResourceIdentity,
	isResourceSourceSnapshotHash,
	parseResourceIdentity,
} from '@core-shared/resource-types';
import { normalizeUrl } from '@core-shared/url';
import { type CoreDb, withCoreDb } from '@db/client';
import { contentResourceIdentitySql } from '@db/resource-identity-sql';
import { type SQL, sql } from 'drizzle-orm';
import { resourceSourceSnapshotHash } from './resource-revision';
import { upsertResourceTranslation } from './resource-translation-store';
import { cleanString, dateValue, requiredString, stringArrayValue } from './resource-values';

/** Failed enrichments to retry before a URL is treated as permanently dead. */
export const MAX_ENRICHMENT_ATTEMPTS = 5;

/**
 * Every Resource row is committed before Workflow admission. A transient
 * binding or Workflows failure can therefore leave a durable pending row
 * behind. The row is the outbox; source revisions preserve the same fixed
 * Workflow identity used by monitored admission.
 */
export async function claimStalePendingResourceAdmissions(
	env: CoreEnv,
	olderThan: Date,
	limit: number,
): Promise<Array<{ resourceId: string; sourceRevision: string | null }>> {
	return withCoreDb(env, async (db) => {
		const claimed = await db.execute<{ resource_id: string; source_revision: string | null }>(sql`
			WITH candidates AS (
				SELECT id
				FROM resources
				WHERE enrichment_status = 'pending'
				  AND updated_at < ${olderThan}
				  AND ${contentResourceIdentitySql({
						kind: sql`kind`,
						resourcePlatform: sql`resource_platform`,
					})}
				ORDER BY updated_at ASC, id ASC
				FOR UPDATE SKIP LOCKED
				LIMIT ${limit}
			)
			UPDATE resources AS resource
			SET updated_at = NOW()
			FROM candidates
			WHERE resource.id = candidates.id
			RETURNING resource.id::text AS resource_id, resource.source_revision
		`);
		return claimed.rows.map(({ resource_id, source_revision }) => ({
			resourceId: resource_id,
			sourceRevision: source_revision,
		}));
	});
}

export type SourceResourceDraft = {
	sourceId: string;
	url: string;
	title: string;
	publishedDate: Date | null;
	summary: string | null;
	originalLang?: string;
	keywords?: string[];
} & ContentResourceIdentity;

type PendingSourceResourceRecord = {
	id: string;
	sourceId: string;
	url: string;
	originalLang: string;
	title: string;
	summary: string | null;
	publishedDate: Date | null;
	scrapedDate: Date;
	keywords: string[];
	sourceRevision: string;
} & ContentResourceIdentity;

async function pendingSourceResourceRecord(base: SourceResourceDraft): Promise<PendingSourceResourceRecord> {
	const explicitIdentity = parseResourceIdentity(base.kind, base.resourcePlatform);
	if (!explicitIdentity || !isContentResourceIdentity(explicitIdentity)) {
		throw new Error(`Invalid source resource identity: ${String(base.kind)} / ${String(base.resourcePlatform)}`);
	}
	const originalLang = canonicalizeOptionalResourceLang(base.originalLang) ?? DEFAULT_RESOURCE_LANG;
	const publishedDate = base.publishedDate === null ? null : dateValue(base.publishedDate, 'published_date');
	const url = normalizeUrl(requiredString(base.url, 'url'));
	const title = requiredString(base.title, 'title');
	const summary = cleanString(base.summary);
	const sourceRevision = await resourceSourceSnapshotHash({
		content: null,
		fileType: null,
		kind: explicitIdentity.kind,
		originalLang,
		publishedDate: publishedDate?.toISOString() ?? null,
		resourcePlatform: explicitIdentity.resourcePlatform,
		summary,
		title,
		translationSource: 'original',
		url,
	});
	return {
		...explicitIdentity,
		id: crypto.randomUUID(),
		sourceId: requiredString(base.sourceId, 'source_id'),
		url,
		originalLang,
		title,
		summary,
		publishedDate,
		scrapedDate: new Date(),
		keywords: stringArrayValue(base.keywords ?? [], 'keywords'),
		sourceRevision,
	};
}

type PendingSourceResource = {
	needsProcessing: boolean;
	resourceId: string;
	sourceRevision: string | null;
};

export async function upsertPendingSourceResource(db: CoreDb, base: SourceResourceDraft): Promise<PendingSourceResource> {
	const record = await pendingSourceResourceRecord(base);
	const result = await db.execute<{ enrichment_status: string; id: string; source_revision: string | null }>(
		resourceInsertStatement(record),
	);
	const row = result.rows[0];
	const resourceId = row?.id;
	if (!resourceId) throw new Error(`Failed to upsert pending resource for ${base.url}`);
	if (row.enrichment_status !== 'enriched') await syncOriginalResourceTranslation(db, resourceId, record);
	return {
		needsProcessing: row.enrichment_status !== 'enriched',
		resourceId,
		sourceRevision: isResourceSourceSnapshotHash(row.source_revision) ? row.source_revision : null,
	};
}

function resourceInsertStatement(record: PendingSourceResourceRecord): SQL {
	return sql`
		INSERT INTO resources (
			id, source_id, kind, resource_platform, scope, url, normalized_url, storage_key, file_type,
			original_lang, published_date, scraped_date, tags, category,
			og_image_url, creators, kind_metadata, source_revision, enrichment_status,
			created_at, updated_at
		)
		VALUES (
			${record.id}::uuid,
			${record.sourceId}::uuid,
			${record.kind},
			${record.resourcePlatform},
			'corpus',
			${record.url},
			${record.url},
			NULL,
			NULL,
			${record.originalLang},
			${record.publishedDate},
			${record.scrapedDate},
			'{}'::text[],
			NULL,
			NULL,
			'[]'::jsonb,
			NULL,
			${record.sourceRevision},
			'pending',
			now(),
			now()
		)
		ON CONFLICT (normalized_url) WHERE normalized_url IS NOT NULL DO UPDATE SET ${resourceConflictSetSql()}
			WHERE resources.scope <> 'private' OR excluded.scope = 'private'
		RETURNING
			id::text AS id,
			enrichment_status,
			source_revision
	`;
}

function resourceConflictSetSql(): SQL {
	const preserveEnriched = sql`excluded.enrichment_status = 'pending' AND resources.enrichment_status = 'enriched'`;
	return sql`
		source_id = COALESCE(resources.source_id, excluded.source_id),
		kind = CASE WHEN ${preserveEnriched} THEN resources.kind ELSE excluded.kind END,
		resource_platform = CASE
			WHEN ${preserveEnriched} THEN resources.resource_platform
			ELSE excluded.resource_platform
		END,
		scope = CASE
			WHEN resources.scope = 'corpus' OR excluded.scope = 'private' THEN resources.scope
			ELSE excluded.scope
		END,
		url = CASE WHEN ${preserveEnriched} THEN resources.url ELSE excluded.url END,
		storage_key = CASE WHEN ${preserveEnriched} THEN resources.storage_key ELSE excluded.storage_key END,
		file_type = CASE WHEN ${preserveEnriched} THEN resources.file_type ELSE excluded.file_type END,
		original_lang = CASE WHEN ${preserveEnriched} THEN resources.original_lang ELSE excluded.original_lang END,
		published_date = CASE
			WHEN ${preserveEnriched} THEN resources.published_date
			ELSE excluded.published_date
		END,
		scraped_date = CASE
			WHEN ${preserveEnriched} THEN resources.scraped_date
			ELSE excluded.scraped_date
		END,
		tags = CASE WHEN ${preserveEnriched} THEN resources.tags ELSE excluded.tags END,
		category = CASE WHEN ${preserveEnriched} THEN resources.category ELSE excluded.category END,
		og_image_url = CASE
			WHEN ${preserveEnriched} THEN resources.og_image_url
			ELSE excluded.og_image_url
		END,
		creators = CASE WHEN ${preserveEnriched} THEN resources.creators ELSE excluded.creators END,
		kind_metadata = CASE WHEN ${preserveEnriched} THEN resources.kind_metadata ELSE excluded.kind_metadata END,
		source_revision = CASE WHEN ${preserveEnriched} THEN resources.source_revision ELSE excluded.source_revision END,
		enrichment_status = CASE
			WHEN ${preserveEnriched} THEN resources.enrichment_status
			ELSE excluded.enrichment_status
		END,
		updated_at = CASE WHEN ${preserveEnriched} THEN resources.updated_at ELSE now() END
	`;
}

async function syncOriginalResourceTranslation(db: CoreDb, resourceId: string, record: PendingSourceResourceRecord): Promise<void> {
	if (
		!(await upsertResourceTranslation(db, {
			resourceId,
			lang: record.originalLang,
			title: record.title,
			summary: record.summary,
			content: null,
			keywords: record.keywords,
			source: 'original',
		}))
	) {
		throw new Error(`Failed to sync original translation for resource ${resourceId}`);
	}
}

/**
 * Finds previously discovered Resources and atomically claims missing source
 * provenance. Provider monitors supply canonical drafts; the store owns the
 * database handshake and returns only the admission decision they need.
 */
export async function claimExistingDiscoveredResources(
	db: CoreDb,
	drafts: Array<Pick<SourceResourceDraft, 'sourceId' | 'url'>>,
): Promise<Array<{ id: string; url: string; shouldRetryEnrichment: boolean }>> {
	const discovered = new Map<string, string>();
	for (const draft of drafts) {
		const url = normalizeUrl(draft.url);
		if (!discovered.has(url)) discovered.set(url, draft.sourceId);
	}
	if (!discovered.size) return [];

	const values = [...discovered].map(([url, sourceId]) => sql`(${url}, ${sourceId}::uuid)`);
	const result = await db.execute<{ id: string; url: string; shouldRetryEnrichment: boolean }>(sql`
		WITH discovered(normalized_url, source_id) AS (
			VALUES ${sql.join(values, sql`, `)}
		), attached AS (
			UPDATE resources AS resource
			SET source_id = discovered.source_id
			FROM discovered
			WHERE resource.normalized_url = discovered.normalized_url
			  AND resource.source_id IS NULL
			  AND ${contentResourceIdentitySql({
					kind: sql`resource.kind`,
					resourcePlatform: sql`resource.resource_platform`,
				})}
			RETURNING resource.id
		)
		SELECT
			resource.id::text AS id,
			resource.normalized_url AS url,
			(
				resource.enrichment_status = 'pending'
				OR (
					resource.enrichment_status = 'failed'
					AND resource.enrichment_attempts < ${MAX_ENRICHMENT_ATTEMPTS}
					-- 30m, 1h, 2h, 4h, then give up: a feed re-lists the same item for
					-- days, and a flat 30-minute window re-ran a dead URL every cycle.
					AND resource.updated_at < NOW() - (
						INTERVAL '30 minutes' * POWER(2, GREATEST(resource.enrichment_attempts, 1) - 1)
					)
				)
			) AS "shouldRetryEnrichment"
		FROM resources AS resource
		JOIN discovered ON discovered.normalized_url = resource.normalized_url
		LEFT JOIN attached ON attached.id = resource.id
		WHERE ${contentResourceIdentitySql({
			kind: sql`resource.kind`,
			resourcePlatform: sql`resource.resource_platform`,
		})}
	`);
	return result.rows;
}
