import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import pLimit from 'p-limit';
import { z } from 'zod';
import { AI_STEP } from '../services/ai-model';
import { extractResourceEntities } from '../services/entities';
import { STORAGE_STEP } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import { listEntityBackfillResources, loadEntitySource, replaceResourceEntities } from '../store/resources';

const EntityBackfillPayloadSchema = z.strictObject({
	since: z.iso.datetime({ offset: true }),
	until: z.iso.datetime({ offset: true }).optional(),
	/** Re-extract Resources that already have entities, e.g. after the extraction prompt changed. */
	replace: z.boolean().optional(),
});
type EntityBackfillPayload = z.infer<typeof EntityBackfillPayloadSchema>;

const PAGE_SIZE = 200;
const EXTRACTION_CONCURRENCY = 25;

/**
 * Extracts entities for stored corpus originals published in a window that have none, or for all of
 * them with `replace`, oldest first, without reacquiring them. A Resource whose extraction keeps failing is skipped; a later run retries it.
 */
export class ResourceEntityBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, EntityBackfillPayload> {
	async run(event: WorkflowEvent<EntityBackfillPayload>, step: WorkflowStep) {
		const { since, until, replace } = EntityBackfillPayloadSchema.parse(event.payload);
		let after: { publishedDate: string; id: string } | null = null;
		let written = 0;
		let failed = 0;
		for (let page = 0; ; page++) {
			const rows = await step.do(`list-entity-backfill-resources-${page}`, STORAGE_STEP, () =>
				withCoreDb(this.env, (db) =>
					listEntityBackfillResources(db, { since, until: until ?? null, after, limit: PAGE_SIZE, replace: replace ?? false }),
				),
			);
			if (!rows.length) break;
			const limit = pLimit(EXTRACTION_CONCURRENCY);
			const results = await Promise.all(
				rows.map(({ id }) =>
					limit(() =>
						step
							.do(`extract-resource-entities-${id}`, AI_STEP, async () => {
								const source = await withCoreDb(this.env, (db) => loadEntitySource(db, id));
								if (!source) return 0;
								const entities = await extractResourceEntities(source, this.env, event.instanceId);
								await withCoreDb(this.env, (db) => db.transaction((tx) => replaceResourceEntities(tx, id, entities)));
								return entities.length;
							})
							.then(
								() => true,
								(error: unknown) => {
									console.error({ tag: 'WORKFLOW', msg: 'Entity backfill failed', resource_id: id, error });
									return false;
								},
							),
					),
				),
			);
			const succeeded = results.filter(Boolean).length;
			written += succeeded;
			failed += results.length - succeeded;
			after = rows.at(-1) ?? null;
		}
		console.info({ tag: 'WORKFLOW', msg: 'Entity backfill completed', since, until, written, failed });
		return { written, failed };
	}
}
