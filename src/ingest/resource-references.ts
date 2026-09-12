import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { connectCoreDb } from '../shared/db';
import { sha256Hex } from '../shared/hash';
import { resolveCrossrefReference } from './crossref';
import { createResourceTask, registerResourceTask, type ResourceTaskContext } from './progress';

const CROSSREF_BATCH_SIZE = 3;
const REFERENCE_DB_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const ResourceReferenceEnrichmentPayloadSchema = z.object({
	progress: z.boolean(),
	referenceRevision: z.hash('md5').lowercase(),
	resourceId: z.uuid(),
});

type CrossrefMetadataUpdate = NonNullable<Awaited<ReturnType<typeof resolveCrossrefReference>>> & Readonly<{ ordinal: number }>;
type ResourceReferenceEnrichmentPayload = z.infer<typeof ResourceReferenceEnrichmentPayloadSchema>;

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

async function persistCrossrefMetadata(
	db: NodePgDatabase,
	resourceId: string,
	referenceRevision: string,
	updates: readonly CrossrefMetadataUpdate[],
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
		SET (doi, url, title, authors, year, venue) =
		    (incoming.doi, incoming.url, incoming.title, incoming.authors, incoming.year, incoming.venue)
		FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS incoming(
			ordinal integer, doi text, url text, title text, authors text[], year integer, venue text
		)
		CROSS JOIN target
		WHERE reference.resource_id = target.id AND reference.ordinal = incoming.ordinal AND reference.doi IS NULL
	`);
	return result.rowCount ?? 0;
}

async function resolveCrossrefUpdates(step: WorkflowStep, references: readonly StoredReference[]): Promise<CrossrefMetadataUpdate[]> {
	const updates: CrossrefMetadataUpdate[] = [];
	for (let offset = 0; offset < references.length; offset += CROSSREF_BATCH_SIZE) {
		const batch = references.slice(offset, offset + CROSSREF_BATCH_SIZE);
		const resolutions = await Promise.all(
			batch.map(({ text, ordinal }) =>
				step
					.do(
						`resolve-crossref-reference-v3-${ordinal}`,
						{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() => resolveCrossrefReference(text),
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
			if (resolution) updates.push({ ...resolution, ordinal: batch[index]!.ordinal });
		}
		if (offset + CROSSREF_BATCH_SIZE < references.length) {
			await step.sleep(`pace-crossref-batch-v2-${offset / CROSSREF_BATCH_SIZE}`, '1 second');
		}
	}
	return updates;
}

export async function enqueueResourceReferenceEnrichment(
	env: CoreEnv,
	resourceId: string,
	referenceRevision: string,
	parent?: ResourceTaskContext,
) {
	const id = `rr-v7-${await sha256Hex([resourceId, referenceRevision, parent?.taskId ?? 'idempotent'].join('\n'))}`;
	await registerResourceTask(env, { taskId: id, kind: 'references', resourceId }, parent);
	await env.RESOURCE_REFERENCE_ENRICHMENT_WORKFLOW.createBatch([
		{
			id,
			params: {
				progress: parent?.required ?? false,
				referenceRevision,
				resourceId,
			},
		},
	]);
}

/** Canonical persistence owns citation data; this follow-up only fills unresolved Crossref metadata. */
export class ResourceReferenceEnrichmentWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceReferenceEnrichmentPayload> {
	async run(event: WorkflowEvent<ResourceReferenceEnrichmentPayload>, step: WorkflowStep): Promise<void> {
		const input = ResourceReferenceEnrichmentPayloadSchema.parse(event.payload);
		const task = createResourceTask(this.env, step, event.instanceId, input.progress);
		try {
			const references = await step.do('load-unresolved-references-v1', REFERENCE_DB_STEP, async () =>
				loadUnresolvedReferences(await connectCoreDb(this.env), input.resourceId, input.referenceRevision),
			);
			const crossrefUpdates = await resolveCrossrefUpdates(step, references);
			const enrichedCount = crossrefUpdates.length
				? await step.do('persist-crossref-reference-metadata-v2', REFERENCE_DB_STEP, async () =>
						persistCrossrefMetadata(await connectCoreDb(this.env), input.resourceId, input.referenceRevision, crossrefUpdates),
					)
				: 0;
			console.info({
				tag: 'RESOURCE_REFERENCES',
				event: 'reference_enrichment_completed',
				resource_id: input.resourceId,
				unresolved_reference_count: references.length,
				crossref_enriched_count: enrichedCount,
			});
			await task.report('complete', {
				stage: 'references',
				status: 'complete',
				resourceId: input.resourceId,
			});
		} catch (error) {
			await task.report('failed', {
				stage: 'references',
				status: 'failed',
				resourceId: input.resourceId,
				errorCode: 'references_failed',
			});
			throw error;
		}
	}
}
