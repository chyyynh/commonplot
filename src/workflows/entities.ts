import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import pLimit from 'p-limit';
import { z } from 'zod';
import { AI_STEP_RETRIES } from '../services/ai-model';
import { extractResourceEntities } from '../services/summary';
import { withCoreDb } from '../store/db';
import { listResourcesWithoutEntities, loadEntitySource, replaceResourceEntities } from '../store/resources';

const EntityBackfillPayloadSchema = z.strictObject({
	since: z.iso.datetime({ offset: true }),
	until: z.iso.datetime({ offset: true }).optional(),
});
type EntityBackfillPayload = z.infer<typeof EntityBackfillPayloadSchema>;

const PAGE_SIZE = 50;
const EXTRACTION_CONCURRENCY = 5;
const STORAGE_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const AI_STEP = { retries: AI_STEP_RETRIES, timeout: '600 seconds' } as const;

/**
 * Extracts entities for stored corpus originals published in a window that have none, without
 * reacquiring them. A Resource whose extraction keeps failing is skipped; a later run retries it.
 */
export class ResourceEntityBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, EntityBackfillPayload> {
	async run(event: WorkflowEvent<EntityBackfillPayload>, step: WorkflowStep) {
		const { since, until } = EntityBackfillPayloadSchema.parse(event.payload);
		let after: string | null = null;
		let written = 0;
		let failed = 0;
		for (let page = 0; ; page++) {
			const ids = await step.do(`list-resources-without-entities-${page}`, STORAGE_STEP, () =>
				withCoreDb(this.env, (db) => listResourcesWithoutEntities(db, { since, until: until ?? null, after, limit: PAGE_SIZE })),
			);
			if (!ids.length) break;
			const limit = pLimit(EXTRACTION_CONCURRENCY);
			const results = await Promise.all(
				ids.map((id) =>
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
			written += results.filter(Boolean).length;
			failed += results.length - results.filter(Boolean).length;
			after = ids.at(-1) ?? null;
		}
		console.info({ tag: 'WORKFLOW', msg: 'Entity backfill completed', since, until, written, failed });
		return { written, failed };
	}
}
