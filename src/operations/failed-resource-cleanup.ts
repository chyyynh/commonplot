import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

// Residue from the pre-2026-08-22 shell-first ingest, which inserted a resource
// row before enrichment and marked it `failed` once retries were exhausted. The
// draft pipeline that replaced it inserts only after acquisition succeeds, so
// no code path produces these rows any more. They carry a title and no content,
// and every read surface requires `enriched`, so they are invisible but still
// occupy canonical URLs and hold carriers' subject pointers hostage.
//
// Deleting one cascades its translations, identifiers, references and system
// saves, and sets `subject_resource_id` back to NULL on any carrier pointing at
// it — which also clears the carrier's `subjectAttached` guard, so a later
// resync re-attempts the subject with today's acquisition code.

// Corpus publication is owned by this internal account. A save from any other
// account means a real person kept the resource, which this cleanup must not
// silently destroy.
const SYSTEM_ACCOUNT_EMAIL = 'opennews-system@internal.newsence.invalid';

const FailedResourceCleanupInputSchema = z.object({ apply: z.boolean().default(false) }).strict();

export type FailedResourceCleanupInput = z.input<typeof FailedResourceCleanupInputSchema>;

type SummaryRow = {
	carriers_losing_subject: number;
	failed_rows: number;
	other_user_saves: number;
	system_saves: number;
	with_content: number;
};

export async function deleteFailedResources(db: NodePgDatabase, rawInput: FailedResourceCleanupInput) {
	const input = FailedResourceCleanupInputSchema.parse(rawInput);
	const summary = await db.execute<SummaryRow>(sql`
		SELECT
			(SELECT COUNT(*)::int FROM resources WHERE enrichment_status = 'failed') AS failed_rows,
			(SELECT COUNT(DISTINCT translation.resource_id)::int
			   FROM resource_translations translation
			   JOIN resources resource ON resource.id = translation.resource_id
			  WHERE resource.enrichment_status = 'failed'
			    AND COALESCE(LENGTH(translation.content), 0) > 0) AS with_content,
			(SELECT COUNT(*)::int
			   FROM resources carrier
			   JOIN resources subject ON subject.id = carrier.subject_resource_id
			  WHERE subject.enrichment_status = 'failed') AS carriers_losing_subject,
			(SELECT COUNT(*)::int
			   FROM resource_saves save
			   JOIN resources resource ON resource.id = save.resource_id
			   JOIN "user" account ON account.id = save.user_id
			  WHERE resource.enrichment_status = 'failed'
			    AND account.email = ${SYSTEM_ACCOUNT_EMAIL}) AS system_saves,
			(SELECT COUNT(*)::int
			   FROM resource_saves save
			   JOIN resources resource ON resource.id = save.resource_id
			   JOIN "user" account ON account.id = save.user_id
			  WHERE resource.enrichment_status = 'failed'
			    AND account.email <> ${SYSTEM_ACCOUNT_EMAIL}) AS other_user_saves
	`);
	const counts = summary.rows[0];
	if (!counts) throw new Error('Failed-resource cleanup could not read its summary');

	// Recorded before the delete: afterwards the pointer is gone, and these are
	// exactly the carriers worth resyncing to re-attempt their subject.
	const carriers = await db.execute<{ carrier_id: string; subject_id: string }>(sql`
		SELECT carrier.id::text AS carrier_id, subject.id::text AS subject_id
		FROM resources carrier
		JOIN resources subject ON subject.id = carrier.subject_resource_id
		WHERE subject.enrichment_status = 'failed'
		ORDER BY carrier.id ASC
	`);
	const report = { ...counts, carriers: carriers.rows };
	if (!input.apply) return { ...report, deleted: 0, deletedIds: [] as string[], dryRun: true };

	const deleted = await db.transaction(async (tx) => {
		// Re-checked inside the transaction: a save that arrived between the
		// report and the write would otherwise be cascaded away unnoticed.
		const guard = await tx.execute<{ blocking_saves: number }>(sql`
			SELECT COUNT(*)::int AS blocking_saves
			FROM resource_saves save
			JOIN resources resource ON resource.id = save.resource_id
			JOIN "user" account ON account.id = save.user_id
			WHERE resource.enrichment_status = 'failed'
			  AND account.email <> ${SYSTEM_ACCOUNT_EMAIL}
		`);
		const blocking = guard.rows[0]?.blocking_saves ?? 0;
		if (blocking > 0) throw new Error(`Refusing to delete: ${blocking} save(s) belong to a real account`);
		return tx.execute<{ resource_id: string }>(sql`
			DELETE FROM resources
			WHERE enrichment_status = 'failed'
			RETURNING id::text AS resource_id
		`);
	});
	const deletedIds = deleted.rows.map((row) => row.resource_id);
	console.info({ tag: 'FAILED_RESOURCE_CLEANUP', event: 'deleted', deleted_count: deletedIds.length });
	return { ...report, deleted: deletedIds.length, deletedIds, dryRun: false };
}
