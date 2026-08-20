import {
	type ContentResourceIdentity,
	canonicalizeOptionalResourceLang,
	DEFAULT_RESOURCE_LANG,
	isContentResourceIdentity,
	isResourceSourceSnapshotHash,
	parseResourceIdentity,
	type ResourceTranslationSource,
} from '@core-shared/resource-types';
import { type CoreDb, textArraySql, uuidArraySql, withCoreDb, withCoreTx } from '@db/client';
import { contentResourceIdentitySql } from '@db/resource-identity-sql';
import { resources, resourceTranslations } from '@db/schema';
import { and, eq, not, type SQL, sql } from 'drizzle-orm';
import { resourceSourceSnapshotHash } from './resource-revision';
import { upsertResourceTranslation } from './resource-translation-store';
import { cleanString, dateValue, requiredString, stringArrayValue } from './resource-values';

/** Failed enrichments to retry before a URL is treated as permanently dead. */
const MAX_ENRICHMENT_ATTEMPTS = 5;

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
	publishedDate: Date | string | null;
	summary: string | null;
	originalLang?: string;
	content: string | null;
	keywords?: string[];
	tags?: string[];
} & ContentResourceIdentity;

type PendingSourceResourceRecord = {
	id: string;
	sourceId: string | null;
	url: string | null;
	normalizedUrl: string | null;
	originalLang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	publishedDate: Date | null;
	scrapedDate: Date;
	keywords: string[];
	tags: string[];
	sourceRevision: string;
} & ContentResourceIdentity;

async function pendingSourceResourceRecord(base: SourceResourceDraft): Promise<PendingSourceResourceRecord> {
	const explicitIdentity = parseResourceIdentity(base.kind, base.resourcePlatform);
	if (!explicitIdentity || !isContentResourceIdentity(explicitIdentity)) {
		throw new Error(`Invalid source resource identity: ${String(base.kind)} / ${String(base.resourcePlatform)}`);
	}
	const originalLang = canonicalizeOptionalResourceLang(base.originalLang) ?? DEFAULT_RESOURCE_LANG;
	const publishedDate = base.publishedDate === null ? null : dateValue(base.publishedDate, 'published_date');
	const sourceRevision = await resourceSourceSnapshotHash({
		content: base.content,
		fileType: null,
		kind: explicitIdentity.kind,
		originalLang,
		publishedDate: publishedDate?.toISOString() ?? null,
		resourcePlatform: explicitIdentity.resourcePlatform,
		summary: base.summary,
		title: base.title,
		translationSource: 'original',
		url: base.url,
	});
	return {
		...explicitIdentity,
		id: crypto.randomUUID(),
		sourceId: cleanString(base.sourceId),
		url: cleanString(base.url),
		normalizedUrl: cleanString(base.url),
		originalLang,
		title: cleanString(base.title),
		summary: cleanString(base.summary),
		content: cleanString(base.content),
		publishedDate,
		scrapedDate: new Date(),
		keywords: stringArrayValue(base.keywords ?? [], 'keywords'),
		tags: stringArrayValue(base.tags ?? [], 'tags'),
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
		resourceUpsertStatement(record),
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

function resourceUpsertStatement(record: PendingSourceResourceRecord): SQL {
	if (record.normalizedUrl) {
		return resourceInsertStatement(
			record,
			sql`ON CONFLICT (normalized_url) WHERE normalized_url IS NOT NULL DO UPDATE SET ${resourceConflictSetSql()}
				WHERE resources.scope <> 'private' OR excluded.scope = 'private'`,
		);
	}
	return resourceInsertStatement(record, sql`ON CONFLICT (id) DO UPDATE SET ${resourceConflictSetSql()}`);
}

function resourceInsertStatement(record: PendingSourceResourceRecord, conflictSql: SQL): SQL {
	const tags = textArraySql(record.tags);
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
			${record.normalizedUrl},
			NULL,
			NULL,
			${record.originalLang},
			${record.publishedDate},
			${record.scrapedDate},
			${tags},
			NULL,
			NULL,
			'[]'::jsonb,
			NULL,
			${record.sourceRevision},
			'pending',
			now(),
			now()
		)
		${conflictSql}
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
			content: record.content,
			keywords: record.keywords,
			source: 'original',
		}))
	) {
		throw new Error(`Failed to sync original translation for resource ${resourceId}`);
	}
}

export type ExistingResourceRecord = {
	id: string;
	url: string;
	shouldRetryEnrichment: boolean;
	needsSourceAttach: boolean;
};

export async function getExistingResourcesByUrl(db: CoreDb, urls: string[]): Promise<ExistingResourceRecord[]> {
	if (urls.length === 0) return [];
	const result = await db.execute<ExistingResourceRecord>(sql`
		SELECT
			r.id::text AS id,
			r.normalized_url AS url,
			(
				r.enrichment_status = 'pending'
				OR (
					r.enrichment_status = 'failed'
					AND r.enrichment_attempts < ${MAX_ENRICHMENT_ATTEMPTS}
					-- 30m, 1h, 2h, 4h, then give up: a feed re-lists the same item for
					-- days, and a flat 30-minute window re-ran a dead URL every cycle.
					AND r.updated_at < NOW() - (INTERVAL '30 minutes' * POWER(2, GREATEST(r.enrichment_attempts, 1) - 1))
				)
			) AS "shouldRetryEnrichment",
			(r.source_id IS NULL) AS "needsSourceAttach"
		FROM resources r
			WHERE r.normalized_url = ANY(${textArraySql(urls)})
			  AND ${contentResourceIdentitySql({
					kind: sql`r.kind`,
					resourcePlatform: sql`r.resource_platform`,
				})}
	`);
	return result.rows;
}

/** Claims unowned rows for a source. Callers pass ids they just read, so the
 *  only guard that can still exclude anything is the unowned check itself. */
export async function attachSourceToResources(db: CoreDb, resourceIds: string[], sourceId: string): Promise<void> {
	if (!resourceIds.length) return;
	await db.execute(sql`
		UPDATE resources
		SET source_id = ${sourceId}::uuid
		WHERE id = ANY(${uuidArraySql(resourceIds)})
		  AND source_id IS NULL
	`);
}

export async function reopenResourceForReprocessing(env: CoreEnv, resourceId: string, update: { content: string }): Promise<string | null> {
	if (!update.content.trim()) {
		throw new Error(`Cannot reopen resource ${resourceId} with empty content`);
	}
	return withCoreTx(env, async (db) => {
		const resourceResult = await db.execute<{
			file_type: string | null;
			kind: string;
			original_lang: string;
			published_date: Date | string | null;
			resource_platform: string | null;
			url: string | null;
		}>(sql`
			SELECT file_type, kind, original_lang, published_date, resource_platform, url
			FROM resources
			WHERE id = ${resourceId}::uuid
			FOR UPDATE
		`);
		const resource = resourceResult.rows[0];
		if (!resource) throw new Error(`Failed to reopen resource ${resourceId}: not found`);

		const translationResult = await db.execute<{
			content: string | null;
			summary: string | null;
			source: ResourceTranslationSource;
			title: string | null;
		}>(sql`
			SELECT content, summary, source, title
			FROM resource_translations
			WHERE resource_id = ${resourceId}::uuid
			  AND lang = ${resource.original_lang}
			FOR UPDATE
		`);
		const original = translationResult.rows[0];
		if (!original) throw new Error(`Failed to reopen resource ${resourceId}: original translation not found`);

		const preserveOwnedTranslation = original.source === 'human';
		const effectiveContent = preserveOwnedTranslation ? original.content : update.content;
		const sourceSummaryChanged = !preserveOwnedTranslation && original.summary !== null;
		const sourceContentChanged = original.content !== effectiveContent;
		if (!sourceSummaryChanged && !sourceContentChanged) return null;

		const sourceSnapshotHash = await resourceSourceSnapshotHash({
			content: effectiveContent,
			fileType: resource.file_type,
			kind: resource.kind,
			originalLang: resource.original_lang,
			publishedDate: resource.published_date === null ? null : dateValue(resource.published_date, 'published_date').toISOString(),
			resourcePlatform: resource.resource_platform,
			summary: preserveOwnedTranslation ? original.summary : null,
			title: requiredString(original.title, 'original translation title'),
			translationSource: original.source,
			url: resource.url,
		});
		await db
			.update(resources)
			.set({
				sourceRevision: sourceSnapshotHash,
				enrichmentStatus: 'pending',
				updatedAt: sql`NOW()`,
			})
			.where(eq(resources.id, resourceId));
		if (
			!(await upsertResourceTranslation(db, {
				resourceId,
				lang: resource.original_lang,
				summary: null,
				content: update.content,
				keywords: [],
				source: 'original',
			}))
		) {
			throw new Error(`Failed to reopen original translation for resource ${resourceId}`);
		}
		if (sourceContentChanged) {
			await db
				.delete(resourceTranslations)
				.where(
					and(
						eq(resourceTranslations.resourceId, resourceId),
						not(eq(resourceTranslations.lang, resource.original_lang)),
						not(eq(resourceTranslations.source, 'human')),
					),
				);
		}
		return sourceSnapshotHash;
	});
}
