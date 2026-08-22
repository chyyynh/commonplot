import { normalizeUrl } from '@core-shared/url';
import type { CoreDb } from '@db/connection';
import { contentResourceIdentitySql } from '@db/resource-identity-sql';
import { sql } from 'drizzle-orm';

/** Re-admits only record-first app-owned blobs whose DB-to-Workflow handoff was interrupted. */
export async function claimStalePendingBlobAdmissions(db: CoreDb, olderThan: Date, limit: number): Promise<Array<{ resourceId: string }>> {
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
		RETURNING resource.id::text AS resource_id
	`);
	return claimed.rows.map(({ resource_id }) => ({ resourceId: resource_id }));
}

/**
 * Finds previously discovered Resources and atomically claims missing source
 * provenance. Provider monitors supply canonical drafts; the store returns
 * only the admission decision they need.
 */
export async function claimExistingDiscoveredResources(
	db: CoreDb,
	drafts: Array<{ sourceId: string; url: string }>,
): Promise<Array<{ id: string; url: string }>> {
	const discovered = new Map<string, string>();
	for (const draft of drafts) {
		const url = normalizeUrl(draft.url);
		if (!discovered.has(url)) discovered.set(url, draft.sourceId);
	}
	if (!discovered.size) return [];

	const values = [...discovered].map(([url, sourceId]) => sql`(${url}, ${sourceId}::uuid)`);
	const result = await db.execute<{ id: string; url: string }>(sql`
		WITH discovered(normalized_url, source_id) AS (
			VALUES ${sql.join(values, sql`, `)}
		), attached AS (
			UPDATE resources AS resource
			SET source_id = discovered.source_id
			FROM discovered
			WHERE resource.normalized_url = discovered.normalized_url
			  AND resource.source_id IS NULL
			  AND resource.enrichment_status = 'enriched'
			  AND ${contentResourceIdentitySql({
					kind: sql`resource.kind`,
					resourcePlatform: sql`resource.resource_platform`,
				})}
			RETURNING resource.id
		)
		SELECT
			resource.id::text AS id,
			resource.normalized_url AS url
		FROM resources AS resource
		JOIN discovered ON discovered.normalized_url = resource.normalized_url
		WHERE resource.enrichment_status = 'enriched'
		  AND ${contentResourceIdentitySql({
				kind: sql`resource.kind`,
				resourcePlatform: sql`resource.resource_platform`,
			})}
	`);
	return result.rows;
}
