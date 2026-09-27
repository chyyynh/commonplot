import type { WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { connectCoreDb } from '../shared/db';
import { fetchCrossrefDepositedReferences, matchDepositedReferences, resolveCrossrefReferenceDoi } from './crossref';

const CROSSREF_BATCH_SIZE = 3;
const REFERENCE_DB_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const CROSSREF_STEP = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
type StoredReference = { ordinal: number; text: string };
type ReferenceDoi = StoredReference & { doi: string };

async function resolveReferenceDois(step: WorkflowStep, references: readonly StoredReference[]): Promise<ReferenceDoi[]> {
	const updates: ReferenceDoi[] = [];
	for (let offset = 0; offset < references.length; offset += CROSSREF_BATCH_SIZE) {
		const batch = references.slice(offset, offset + CROSSREF_BATCH_SIZE);
		const resolutions = await Promise.all(
			batch.map(({ text, ordinal }) =>
				step
					.do(`resolve-crossref-reference-doi-v2-${ordinal}`, CROSSREF_STEP, () => resolveCrossrefReferenceDoi(text))
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

/**
 * Give this paper's printed bibliography DOIs. A paper with a DOI reads its publisher's deposited
 * reference list once; only without a deposited list (preprints, closed publishers) does each citation search Crossref.
 */
export async function stageResourceReferences(env: CoreEnv, step: WorkflowStep, resourceId: string): Promise<void> {
	const referenceStream = await step.do('load-unresolved-references-v3', REFERENCE_DB_STEP, async () => {
		const db = await connectCoreDb(env);
		const result = await db.execute<{ doi: string | null; references: StoredReference[] }>(sql`
			SELECT (
				SELECT identifier.value FROM resource_identifiers identifier
				WHERE identifier.resource_id = resource.id AND identifier.scheme = 'doi' AND identifier.value NOT LIKE '10.48550/%'
				ORDER BY identifier.is_preferred DESC, identifier.value LIMIT 1
			) AS doi, COALESCE((
				SELECT jsonb_agg(jsonb_build_object('ordinal', reference.ordinal, 'text', reference.text) ORDER BY reference.ordinal)
				FROM resource_references reference
				WHERE reference.resource_id = resource.id AND reference.doi IS NULL AND reference.arxiv_id IS NULL
			), '[]'::jsonb) AS references
			FROM resources resource
			WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.kind = 'paper'
		`);
		return Response.json(result.rows[0] ?? { doi: null, references: [] }).body!;
	});
	const { doi, references } = await new Response(referenceStream).json<{ doi: string | null; references: StoredReference[] }>();
	if (!references.length) return;
	const deposited = doi
		? await new Response(
				await step.do(
					'fetch-crossref-deposited-references-v1',
					CROSSREF_STEP,
					async () => Response.json(await fetchCrossrefDepositedReferences(doi)).body!,
				),
			).json<Awaited<ReturnType<typeof fetchCrossrefDepositedReferences>>>()
		: [];
	const updates = deposited.length ? matchDepositedReferences(references, deposited) : await resolveReferenceDois(step, references);
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
		source: deposited.length ? 'deposited' : 'search',
		deposited_count: deposited.length,
		unresolved_reference_count: references.length,
		crossref_enriched_count: enrichedCount,
	});
}
