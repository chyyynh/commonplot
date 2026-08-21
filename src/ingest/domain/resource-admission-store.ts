import type { ContentResourceIdentity } from '@core-shared/resource-types';
import { normalizeUrl } from '@core-shared/url';
import { type CoreDb, withCoreDb } from '@db/client';
import { contentResourceIdentitySql } from '@db/resource-identity-sql';
import { sql } from 'drizzle-orm';

/** Failed enrichments to retry before a URL is treated as permanently dead. */
export const MAX_ENRICHMENT_ATTEMPTS = 5;

/** Re-admits historical pending rows and record-first app-owned blob rows. */
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

/**
 * Finds previously discovered Resources and atomically claims missing source
 * provenance. Provider monitors supply canonical drafts; the store owns the
 * database handshake and returns only the admission decision they need.
 */
export async function claimExistingDiscoveredResources(
	db: CoreDb,
	drafts: Array<{ sourceId: string; url: string } & ContentResourceIdentity>,
): Promise<Array<{ enrichmentStatus: string; id: string; url: string; shouldRetryEnrichment: boolean }>> {
	const discovered = new Map<string, string>();
	for (const draft of drafts) {
		const url = normalizeUrl(draft.url);
		if (!discovered.has(url)) discovered.set(url, draft.sourceId);
	}
	if (!discovered.size) return [];

	const values = [...discovered].map(([url, sourceId]) => sql`(${url}, ${sourceId}::uuid)`);
	const result = await db.execute<{ enrichmentStatus: string; id: string; url: string; shouldRetryEnrichment: boolean }>(sql`
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
			resource.enrichment_status AS "enrichmentStatus",
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
