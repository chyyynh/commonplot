import type { WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connectCoreDb } from '../shared/db';
import { resolveCrossrefReference } from './crossref';
import { createResourceTask, registerResourceTask, type ResourceTaskContext } from './progress';

const CROSSREF_BATCH_SIZE = 3;
const REFERENCE_DB_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
type ReferenceDoi = { ordinal: number; doi: string };
type StoredReference = { ordinal: number; text: string };

async function loadUnresolvedReferences(db: NodePgDatabase, resourceId: string, referenceRevision: string): Promise<StoredReference[]> {
	const result = await db.execute<StoredReference>(sql`
		SELECT reference.ordinal, reference.text
		FROM resource_references reference
		JOIN resources resource ON resource.id = reference.resource_id
		JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
		WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.kind = 'paper'
		  AND reference.doi IS NULL
		  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
		ORDER BY reference.ordinal
	`);
	return result.rows;
}

async function persistReferenceDois(
	db: NodePgDatabase,
	resourceId: string,
	referenceRevision: string,
	updates: readonly ReferenceDoi[],
): Promise<number> {
	const result = await db.execute(sql`
		WITH target AS (
			SELECT resource.id
			FROM resources resource
			JOIN resource_translations original ON original.resource_id = resource.id AND original.lang = resource.original_lang
			WHERE resource.id = ${resourceId}::uuid AND resource.scope = 'corpus' AND resource.kind = 'paper'
			  AND MD5(jsonb_build_array(original.lang, original.title, original.summary, original.content)::text) = ${referenceRevision}
			FOR UPDATE OF resource, original
		)
		UPDATE resource_references AS reference
		SET doi = incoming.doi
		FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS incoming(ordinal integer, doi text)
		CROSS JOIN target
		WHERE reference.resource_id = target.id AND reference.ordinal = incoming.ordinal AND reference.doi IS NULL
	`);
	return result.rowCount ?? 0;
}

async function resolveReferenceDois(step: WorkflowStep, references: readonly StoredReference[]): Promise<ReferenceDoi[]> {
	const updates: ReferenceDoi[] = [];
	for (let offset = 0; offset < references.length; offset += CROSSREF_BATCH_SIZE) {
		const batch = references.slice(offset, offset + CROSSREF_BATCH_SIZE);
		const resolutions = await Promise.all(
			batch.map(({ text, ordinal }) =>
				step
					.do(
						`resolve-crossref-reference-doi-v1-${ordinal}`,
						{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						async () => (await resolveCrossrefReference(text))?.doi ?? null,
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
			if (resolution) updates.push({ doi: resolution, ordinal: batch[index]!.ordinal });
		}
		if (offset + CROSSREF_BATCH_SIZE < references.length) {
			await step.sleep(`pace-crossref-batch-v2-${offset / CROSSREF_BATCH_SIZE}`, '1 second');
		}
	}
	return updates;
}

/** Continue the import's durable background work after its original is readable. */
export async function stageResourceReferences(
	env: CoreEnv,
	step: WorkflowStep,
	resourceId: string,
	referenceRevision: string,
	parent: ResourceTaskContext,
): Promise<void> {
	const task = createResourceTask(env, step, `references-${parent.taskId}`, parent.required);
	try {
		if (parent.required)
			await step.do('register-reference-progress-v1', REFERENCE_DB_STEP, () =>
				registerResourceTask(env, { taskId: task.taskId, kind: 'references', resourceId }, parent),
			);
		const references = await step.do('load-unresolved-references-v1', REFERENCE_DB_STEP, async () =>
			loadUnresolvedReferences(await connectCoreDb(env), resourceId, referenceRevision),
		);
		const updates = await resolveReferenceDois(step, references);
		const enrichedCount = updates.length
			? await step.do('persist-crossref-reference-dois-v1', REFERENCE_DB_STEP, async () =>
					persistReferenceDois(await connectCoreDb(env), resourceId, referenceRevision, updates),
				)
			: 0;
		console.info({
			tag: 'RESOURCE_REFERENCES',
			event: 'reference_enrichment_completed',
			resource_id: resourceId,
			unresolved_reference_count: references.length,
			crossref_enriched_count: enrichedCount,
		});
		await task.report('references-complete', {
			stage: 'references',
			status: 'complete',
			resourceId,
		});
	} catch (error) {
		await task.report('references-failed', {
			stage: 'references',
			status: 'failed',
			resourceId,
			errorCode: 'references_failed',
		});
		throw error;
	}
}
