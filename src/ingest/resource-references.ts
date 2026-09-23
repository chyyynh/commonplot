import type { WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { connectCoreDb } from '../shared/db';
import { resolveCrossrefReferenceDoi } from './crossref';

const CROSSREF_BATCH_SIZE = 3;
const REFERENCE_DB_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
type StoredReference = { ordinal: number; text: string };
type ReferenceDoi = StoredReference & { doi: string };

async function resolveReferenceDois(step: WorkflowStep, references: readonly StoredReference[]): Promise<ReferenceDoi[]> {
	const updates: ReferenceDoi[] = [];
	for (let offset = 0; offset < references.length; offset += CROSSREF_BATCH_SIZE) {
		const batch = references.slice(offset, offset + CROSSREF_BATCH_SIZE);
		const resolutions = await Promise.all(
			batch.map(({ text, ordinal }) =>
				step
					.do(
						`resolve-crossref-reference-doi-v2-${ordinal}`,
						{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() => resolveCrossrefReferenceDoi(text),
					)
					.catch((error) => {
						console.warn({
							tag: 'CROSSREF',
							event: 'reference_resolution_failed',
							ordinal,
							error: error instanceof Error ? error.message : String(error),
						});
						return null;
					}),
			),
		);
		for (const [index, resolution] of resolutions.entries()) {
			if (resolution) updates.push({ ...batch[index]!, doi: resolution });
		}
		if (offset + CROSSREF_BATCH_SIZE < references.length) {
			await step.sleep(`pace-crossref-batch-v2-${offset / CROSSREF_BATCH_SIZE}`, '1 second');
		}
	}
	return updates;
}

/** Resolve and persist DOI matches for this paper's accepted bibliography. */
export async function stageResourceReferences(env: CoreEnv, step: WorkflowStep, resourceId: string): Promise<void> {
	const referenceStream = await step.do('load-unresolved-references-v2', REFERENCE_DB_STEP, async () => {
		const db = await connectCoreDb(env);
		const result = await db.execute<StoredReference>(sql`
			SELECT reference.ordinal, reference.text
			FROM resource_references reference
			JOIN resources resource ON resource.id = reference.resource_id
			WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.kind = 'paper'
			  AND reference.doi IS NULL AND reference.arxiv_id IS NULL
			ORDER BY reference.ordinal
		`);
		return Response.json(result.rows).body!;
	});
	const references = await new Response(referenceStream).json<StoredReference[]>();
	const updates = await resolveReferenceDois(step, references);
	const enrichedCount = updates.length
		? await step.do('persist-crossref-reference-dois-v2', REFERENCE_DB_STEP, async () => {
				const db = await connectCoreDb(env);
				// A DOI belongs to this exact bibliography entry, independently of title, summary or body edits.
				const result = await db.execute(sql`
					WITH target AS (
						SELECT resource.id
						FROM resources resource
						WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.kind = 'paper'
						FOR UPDATE
					)
					UPDATE resource_references AS reference
					SET doi = incoming.doi
					FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS incoming(ordinal integer, text text, doi text)
					CROSS JOIN target
					WHERE reference.resource_id = target.id AND reference.ordinal = incoming.ordinal
					  AND reference.text = incoming.text
					  AND reference.doi IS NULL AND reference.arxiv_id IS NULL
				`);
				return result.rowCount ?? 0;
			})
		: 0;
	console.info({
		tag: 'RESOURCE_REFERENCES',
		event: 'reference_enrichment_completed',
		resource_id: resourceId,
		unresolved_reference_count: references.length,
		crossref_enriched_count: enrichedCount,
	});
}
