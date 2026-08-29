import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

// Subjects acquired before carriers forwarded their publication date kept a
// NULL `published_date`, which excludes them from the chronological feed. This
// replays that hint over existing rows: a subject page that states no date of
// its own inherits the date of the carrier that surfaced it.
//
// A URL can be carried more than once (the same link submitted twice). Runtime
// attaches the subject to whichever carrier reached it first and later carriers
// leave the attached subject alone, so the earliest carrier date is the one
// that mirrors what acquisition would have produced.

const SubjectPublishedDateBackfillInputSchema = z
	.object({ apply: z.boolean().default(false), limit: z.number().int().min(1).max(2_000).default(500) })
	.strict();

export type SubjectPublishedDateBackfillInput = z.input<typeof SubjectPublishedDateBackfillInputSchema>;

type CandidateRow = {
	carrier_count: number;
	enrichment_status: string;
	inherited_date: string;
	resource_id: string;
	url: string | null;
};

export async function backfillSubjectPublishedDates(db: NodePgDatabase, rawInput: SubjectPublishedDateBackfillInput) {
	const input = SubjectPublishedDateBackfillInputSchema.parse(rawInput);
	const candidates = await db.execute<CandidateRow>(sql`
		SELECT subject.id::text AS resource_id,
		       subject.enrichment_status,
		       subject.url,
		       COUNT(carrier.id)::int AS carrier_count,
		       MIN(carrier.published_date) AS inherited_date
		FROM resources subject
		JOIN resources carrier
		  ON carrier.subject_resource_id = subject.id
		 AND carrier.published_date IS NOT NULL
		WHERE subject.published_date IS NULL
		GROUP BY subject.id, subject.enrichment_status, subject.url
		ORDER BY MIN(carrier.published_date) DESC, subject.id ASC
		LIMIT ${input.limit}
	`);
	const rows = candidates.rows;
	const summary = {
		candidates: rows.length,
		enriched: rows.filter((row) => row.enrichment_status === 'enriched').length,
		multiCarrier: rows.filter((row) => row.carrier_count > 1).length,
	};
	if (!input.apply) return { ...summary, applied: 0, appliedIds: [] as string[], dryRun: true, rows };

	// The NULL guard is repeated here so a concurrent acquisition that resolved
	// a real date for the subject page always wins over the inherited one.
	const updated = await db.execute<{ resource_id: string }>(sql`
		UPDATE resources subject
		SET published_date = carrier.inherited_date,
		    updated_at = NOW()
		FROM (
			SELECT subject_resource_id AS id, MIN(published_date) AS inherited_date
			FROM resources
			WHERE subject_resource_id IS NOT NULL
			  AND published_date IS NOT NULL
			GROUP BY subject_resource_id
		) carrier
		WHERE subject.id = carrier.id
		  AND subject.published_date IS NULL
		  AND subject.id = ANY(${rows.map((row) => row.resource_id)}::uuid[])
		RETURNING subject.id::text AS resource_id
	`);
	// Returned so the caller can record exactly which rows changed; the write is
	// otherwise indistinguishable from a date the subject page stated itself.
	const appliedIds = updated.rows.map((row) => row.resource_id);
	console.info({
		tag: 'SUBJECT_PUBLISHED_DATE',
		event: 'backfill_page_applied',
		applied_count: appliedIds.length,
		candidate_count: rows.length,
	});
	return { ...summary, applied: appliedIds.length, appliedIds, dryRun: false, rows };
}
