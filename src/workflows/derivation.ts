// Derivations of a written original — its AI summary and its entities. Each is recorded in resource_derivations,
// so a failure leaves the Resource published and a later sweep runs it again.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { coreExports } from '../exports.ts';
import { AI_STEP } from '../services/ai-model';
import { extractResourceEntities } from '../services/entities';
import { summarizeResource } from '../services/summary';
import { STORAGE_STEP } from '../services/workflow-step';
import { withCoreDb } from '../store/db';
import {
	claimDueDerivations,
	completeEntities,
	completeSummary,
	type DerivationKind,
	type DerivationSource,
	failDerivation,
	loadDerivationSource,
} from '../store/derivations';
import { enqueueLateSummaryTranslation } from './translation';

/** Runs one derivation for the text `inputHash` names; true when it wrote something. A failure is recorded, not thrown. */
export async function deriveResource(
	env: CoreEnv,
	step: WorkflowStep,
	resourceId: string,
	inputHash: string,
	source: DerivationSource,
	kind: DerivationKind,
	processingId: string,
): Promise<boolean> {
	try {
		if (kind === 'summary') {
			const summary = await step.do('derive-summary-v1', AI_STEP, () => summarizeResource(source, env, processingId));
			return await step.do('persist-derived-summary-v1', STORAGE_STEP, () =>
				withCoreDb(env, (db) => completeSummary(db, resourceId, inputHash, summary)),
			);
		}
		const entities = await step.do('derive-entities-v1', AI_STEP, () => extractResourceEntities(source, env, processingId));
		return await step.do('persist-derived-entities-v1', STORAGE_STEP, () =>
			withCoreDb(env, (db) => completeEntities(db, resourceId, inputHash, entities)),
		);
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error({
			tag: 'DERIVATION',
			msg: 'Derivation failed',
			kind,
			resource_id: resourceId,
			processing_id: processingId,
			error: message,
		});
		await step.do(`record-failed-${kind}-v1`, STORAGE_STEP, () =>
			withCoreDb(env, (db) => failDerivation(db, resourceId, kind, inputHash, message)),
		);
		return false;
	}
}

type ResourceDerivationPayload = { resourceId: string; kind: DerivationKind; inputHash: string };

/** A derivation the sweep took over: the attempt that wrote its original failed it or never settled it. */
export class ResourceDerivationWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceDerivationPayload> {
	async run(event: WorkflowEvent<ResourceDerivationPayload>, step: WorkflowStep) {
		const { resourceId, kind, inputHash } = event.payload;
		const source = await step.do('load-derivation-source-v1', STORAGE_STEP, () =>
			withCoreDb(this.env, (db) => loadDerivationSource(db, resourceId, inputHash)),
		);
		if (!source) return { status: 'superseded' as const };
		if (!(await deriveResource(this.env, step, resourceId, inputHash, source, kind, event.instanceId)))
			return { status: 'unchanged' as const };
		// A late summary still needs its translation, and search documents lead with it.
		if (kind === 'summary') {
			await step.do('enqueue-late-summary-translation-v1', STORAGE_STEP, () => enqueueLateSummaryTranslation(this.env, resourceId));
			await step.do('enqueue-summary-search-sync-v1', STORAGE_STEP, async () => {
				await this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId });
			});
		}
		return { status: 'written' as const };
	}
}

const DERIVATION_SWEEP_BATCH = 10;

/** Starts each derivation whose attempt failed or never settled; its lease keeps the next sweep from starting it again. */
export async function enqueueDueDerivations(db: NodePgDatabase): Promise<void> {
	const due = await claimDueDerivations(db, DERIVATION_SWEEP_BATCH);
	if (!due.length) return;
	await coreExports.ResourceDerivationWorkflow.createBatch(
		due.map(({ resourceId, kind, inputHash }) => ({
			id: `rd-v1-${kind}-${resourceId}-${crypto.randomUUID()}`,
			params: { resourceId, kind, inputHash },
		})),
	);
	console.info({ tag: 'DERIVATION', msg: 'Due derivation sweep', started: due.length });
}
