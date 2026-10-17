// Derivations of a written original — its AI summary, its entities and its translations. Each is recorded in
// resource_derivations, so a failure leaves the Resource published and a later sweep runs it again.
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
	type Derivation,
	type DerivationSource,
	failDerivation,
	loadDerivationSource,
} from '../store/derivations';
import { resumeTranslation } from './translation';

/** What this Workflow derives itself; translations run in their own. */
type DirectDerivation = Exclude<Derivation, { kind: 'translation' }>;

/** Runs one derivation for the text `inputHash` names; true when it wrote something. A failure is recorded, not thrown. */
export async function deriveResource(
	env: CoreEnv,
	step: WorkflowStep,
	resourceId: string,
	inputHash: string,
	source: DerivationSource,
	derivation: DirectDerivation,
	processingId: string,
): Promise<boolean> {
	const { kind, lang } = derivation;
	try {
		if (kind === 'summary') {
			const summary = await step.do(`derive-summary-${lang}-v2`, AI_STEP, () => summarizeResource(source, lang, env, processingId));
			return await step.do(`persist-derived-summary-${lang}-v2`, STORAGE_STEP, () =>
				withCoreDb(env, (db) => completeSummary(db, resourceId, inputHash, lang, summary)),
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
			lang,
			resource_id: resourceId,
			processing_id: processingId,
			error: message,
		});
		await step.do(`record-failed-${kind}${lang && `-${lang}`}-v1`, STORAGE_STEP, () =>
			withCoreDb(env, (db) => failDerivation(db, resourceId, derivation, inputHash, message)),
		);
		return false;
	}
}

type ResourceDerivationPayload = DirectDerivation & { resourceId: string; inputHash: string };

/** A derivation the sweep took over: the attempt that wrote its original failed it or never settled it. */
export class ResourceDerivationWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceDerivationPayload> {
	async run(event: WorkflowEvent<ResourceDerivationPayload>, step: WorkflowStep) {
		const { resourceId, inputHash, ...derivation } = event.payload;
		// A failed load counts as an attempt too: the next attempt has a new instance id, and this one would never rerun.
		const source = await step
			.do('load-derivation-source-v1', STORAGE_STEP, () => withCoreDb(this.env, (db) => loadDerivationSource(db, resourceId, inputHash)))
			.catch(async (error: unknown) => {
				const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				await step.do('record-failed-load-v1', STORAGE_STEP, () =>
					withCoreDb(this.env, (db) => failDerivation(db, resourceId, derivation, inputHash, message)),
				);
				return undefined;
			});
		if (source === undefined) return { status: 'unchanged' as const };
		if (!source) return { status: 'superseded' as const };
		if (!(await deriveResource(this.env, step, resourceId, inputHash, source, derivation, event.instanceId)))
			return { status: 'unchanged' as const };
		// Search documents lead with the summary.
		if (derivation.kind === 'summary') {
			await step.do('enqueue-summary-search-sync-v1', STORAGE_STEP, async () => {
				await this.env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId });
			});
		}
		return { status: 'written' as const };
	}
}

// Sized to regenerate every titled Resource's summaries within a day of a summary prompt change.
const DERIVATION_SWEEP_BATCH = 300;

/**
 * Starts each derivation whose attempt failed or never settled; its lease keeps the next sweep from starting it again.
 * The instance id names the text and the attempt, so a sweep that takes over a still-running attempt finds that instance
 * instead of starting a second one.
 */
export async function enqueueDueDerivations(db: NodePgDatabase): Promise<void> {
	const due = await claimDueDerivations(db, DERIVATION_SWEEP_BATCH);
	if (!due.length) return;
	// One translation run covers both languages of a text.
	const translations = new Map(due.flatMap(({ kind, resourceId, inputHash }) => (kind === 'translation' ? [[resourceId, inputHash]] : [])));
	const resumed = await Promise.allSettled(
		[...translations].map(([resourceId, inputHash]) => resumeTranslation(db, resourceId, inputHash)),
	);
	const instances = due
		.filter(({ kind }) => kind !== 'translation')
		.map(({ resourceId, kind, lang, inputHash, attempts }) => ({
			id: `rd-v2-${kind}${lang ? `-${lang}` : ''}-${resourceId}-${inputHash.slice(0, 16)}-${attempts}`,
			params: { resourceId, inputHash, ...({ kind, lang } as DirectDerivation) },
		}));
	// createBatch takes at most 100 instances.
	for (let offset = 0; offset < instances.length; offset += 100)
		await coreExports.ResourceDerivationWorkflow.createBatch(instances.slice(offset, offset + 100));
	console.info({
		tag: 'DERIVATION',
		msg: 'Due derivation sweep',
		started: instances.length,
		translations: translations.size,
		failed: resumed.filter(({ status }) => status === 'rejected').length,
	});
}
