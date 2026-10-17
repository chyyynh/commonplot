// The admission ledger's side effects: each request's lead starts the one workflow its key needs, a sweep restarts or
// settles leads whose workflow went missing, and Web's imports read their progress from their own rows.
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { coreExports } from '../exports.ts';
import {
	claimStaleLeads,
	completeUserRequests,
	failRequests,
	loadImportRequests,
	promoteOrphanRequests,
	recordRequests,
	type RequestLead,
	type ResourceRequest,
	unsavedUserRequests,
	type UserRequest,
} from '../store/requests';
import { importTranslationProgress } from './translation';

const WORKFLOW_RETENTION = { successRetention: '1 day', errorRetention: '7 days' } as const;
const SWEEP_BATCH = 20;

/** Starts each lead's workflow; one already started is left alone. */
async function startLeads(db: NodePgDatabase, leads: readonly RequestLead[]) {
	const instances = leads.flatMap(({ workflowId, params }) => (params ? [{ id: workflowId, params, retention: WORKFLOW_RETENTION }] : []));
	await Promise.all(leads.filter(({ params }) => !params).map(({ id }) => failRequests(db, id, 'The Resource to reacquire was deleted')));
	for (let offset = 0; offset < instances.length; offset += 100)
		await coreExports.ResourceProcessingV2Workflow.createBatch(instances.slice(offset, offset + 100));
}

/** Records requests and starts the acquisitions they lead; returns the leads. */
export async function admitRequests(db: NodePgDatabase, requests: readonly ResourceRequest[]) {
	const leads = await recordRequests(db, requests);
	await startLeads(db, leads);
	return leads;
}

/** What Web's save completes for a user request. */
export function requestSaveTarget(request: UserRequest) {
	return request.storedObjectId
		? { kind: 'userFileResult', objectId: request.storedObjectId, workflowId: `app-ingest-v1-${request.id}` }
		: { kind: 'resourceSave', userId: request.userId, notebookId: request.notebookId };
}

async function workflowState(id: string) {
	try {
		return (await (await coreExports.ResourceProcessingV2Workflow.get(id)).status()).status;
	} catch {
		return 'absent' as const;
	}
}

/**
 * Cron sweep: a lead whose workflow never started is started, one that ended without settling its requests fails them,
 * waiting requests a settled lead left behind take over, and saves a lost workflow never completed are completed.
 */
export async function reconcileRequests(env: CoreEnv, db: NodePgDatabase) {
	const stale = await claimStaleLeads(db, SWEEP_BATCH);
	const restarts: RequestLead[] = [];
	await Promise.all(
		stale.map(async (lead) => {
			const state = await workflowState(lead.workflowId);
			if (state === 'absent') restarts.push(lead);
			else if (state === 'errored' || state === 'terminated' || state === 'complete')
				await failRequests(db, lead.id, `Workflow ${state} without settling its request`);
		}),
	);
	const promoted = await promoteOrphanRequests(db, SWEEP_BATCH);
	await startLeads(db, [...restarts, ...promoted]);
	const unsaved = await unsavedUserRequests(db, SWEEP_BATCH);
	for (const request of unsaved) {
		try {
			await env.APP.completeResourceSave(request.resourceId, requestSaveTarget(request));
			await completeUserRequests(db, [request.id], null);
		} catch (error) {
			console.error({ tag: 'REQUEST', msg: 'Recovered save failed', request_id: request.id, error });
		}
	}
	if (stale.length || promoted.length || unsaved.length)
		console.info({
			tag: 'REQUEST',
			msg: 'Request sweep',
			checked: stale.length,
			restarted: restarts.length,
			promoted: promoted.length,
			saved: unsaved.length,
		});
}

export type ResourceImportExecution =
	| { state: 'absent' | 'queued' | 'running' | 'failed' }
	| { state: 'ready'; resourceId: string; translation?: 'running' | 'failed' };

/** An import's progress from its request: readable once its Resource is written, settled once its save and translation are. */
export async function resourceImportExecutions(db: NodePgDatabase, workflowIds: readonly string[]) {
	const ids = workflowIds.map((id) => id.slice('app-ingest-v1-'.length));
	const requests = new Map((await loadImportRequests(db, ids)).map((request) => [request.id, request]));
	return Object.fromEntries(
		await Promise.all(
			workflowIds.map(async (workflowId, index): Promise<[string, ResourceImportExecution]> => {
				const request = requests.get(ids[index]!);
				if (!request) return [workflowId, await legacyImportExecution(workflowId)];
				const { status, resourceId, translationId, textHash } = request;
				if (status === 'failed' || (status === 'fulfilled' && !resourceId)) return [workflowId, { state: 'failed' }];
				if (!resourceId) return [workflowId, { state: 'running' }];
				if (status === 'pending') return [workflowId, { state: 'ready', resourceId, translation: 'running' }];
				const translation = translationId && textHash ? await importTranslationProgress(resourceId, textHash, translationId) : undefined;
				return [workflowId, { state: 'ready', resourceId, ...(translation ? { translation } : {}) }];
			}),
		),
	);
}

/** What a workflow admitted before the ledger returned. */
type LegacyProcessingOutput =
	| { outcome: 'ready'; resourceId: string; textHash: string; translationId?: string }
	| { outcome: 'superseded' };

/** An import admitted before the ledger, read from its workflow until those age out of Web's inbox. */
async function legacyImportExecution(id: string): Promise<ResourceImportExecution> {
	let snapshot: Awaited<ReturnType<WorkflowInstance['status']>>;
	try {
		snapshot = await (await coreExports.ResourceProcessingV2Workflow.get(id)).status();
	} catch {
		return { state: 'absent' };
	}
	switch (snapshot.status) {
		case 'queued':
			return { state: 'queued' };
		case 'errored':
		case 'terminated':
			return { state: 'failed' };
		case 'complete': {
			const output = snapshot.output as LegacyProcessingOutput;
			if (output.outcome === 'superseded') return { state: 'failed' };
			const translation = output.translationId
				? await importTranslationProgress(output.resourceId, output.textHash, output.translationId)
				: undefined;
			return { state: 'ready', resourceId: output.resourceId, ...(translation ? { translation } : {}) };
		}
		default:
			return { state: 'running' };
	}
}
