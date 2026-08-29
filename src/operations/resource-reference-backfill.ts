import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { bibliographyFromMarkdown } from '../ingest/bibliography';
import { replaceResourceReferences } from '../ingest/resource-references';

const ResourceReferenceBackfillInputSchema = z
	.object({ afterResourceId: z.uuid().nullable().optional(), limit: z.number().int().min(1).max(50).default(25) })
	.strict();

export type ResourceReferenceBackfillInput = z.input<typeof ResourceReferenceBackfillInputSchema>;

export async function backfillResourceReferences(db: NodePgDatabase, rawInput: ResourceReferenceBackfillInput) {
	const input = ResourceReferenceBackfillInputSchema.parse(rawInput);
	const candidates = await db.execute<{ resource_id: string }>(sql`
		SELECT resource.id::text AS resource_id
		FROM resources resource
		JOIN resource_translations original
		  ON original.resource_id = resource.id
		 AND original.lang = resource.original_lang
		WHERE resource.kind = 'paper'
		  AND resource.enrichment_status = 'enriched'
		  AND (${input.afterResourceId ?? null}::uuid IS NULL OR resource.id > ${input.afterResourceId ?? null}::uuid)
		ORDER BY resource.id ASC
		LIMIT ${input.limit}
	`);
	const results = [];
	for (const candidate of candidates.rows) {
		try {
			const extractedCount = await db.transaction(async (tx) => {
				const original = await tx.execute<{ content: string | null }>(sql`
					SELECT original.content
					FROM resources resource
					JOIN resource_translations original
					  ON original.resource_id = resource.id
					 AND original.lang = resource.original_lang
					WHERE resource.id = ${candidate.resource_id}::uuid
					  AND resource.kind = 'paper'
					  AND resource.enrichment_status = 'enriched'
					FOR UPDATE OF resource
				`);
				const authoritativeOriginal = original.rows[0];
				if (!authoritativeOriginal) throw new Error('Paper is no longer eligible for reference backfill');
				const references = bibliographyFromMarkdown(authoritativeOriginal.content ?? '');
				await replaceResourceReferences(tx, candidate.resource_id, references);
				return references.length;
			});
			console.info({
				tag: 'RESOURCE_REFERENCES',
				event: 'backfill_completed',
				resource_id: candidate.resource_id,
				extracted_count: extractedCount,
			});
			results.push({ resourceId: candidate.resource_id, extractedCount });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error({
				tag: 'RESOURCE_REFERENCES',
				event: 'backfill_failed',
				resource_id: candidate.resource_id,
				error: message,
			});
			results.push({ resourceId: candidate.resource_id, extractedCount: null, error: message });
		}
	}
	const pageFailed = results.some((result) => result.extractedCount === null);
	return {
		nextCursor: pageFailed
			? (input.afterResourceId ?? null)
			: candidates.rows.length === input.limit
				? (candidates.rows.at(-1)?.resource_id ?? null)
				: null,
		results,
	};
}
