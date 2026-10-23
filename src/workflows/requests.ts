// The admission ledger's side effects: each request's lead starts the one workflow its key needs, and a sweep restarts
// or settles leads whose workflow went missing.
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { coreExports } from '../exports.ts';
import {
	claimStaleLeads,
	failRequests,
	promoteOrphanRequests,
	recordRequests,
	type RequestLead,
	type ResourceRequest,
} from '../store/requests';

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

async function workflowState(id: string) {
	try {
		return (await (await coreExports.ResourceProcessingV2Workflow.get(id)).status()).status;
	} catch {
		return 'absent' as const;
	}
}

/**
 * Cron sweep: a lead whose workflow never started is started, one that ended without settling its requests fails them,
 * and waiting requests a settled lead left behind take over.
 */
export async function reconcileRequests(db: NodePgDatabase) {
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
	if (stale.length || promoted.length)
		console.info({
			tag: 'REQUEST',
			msg: 'Request sweep',
			checked: stale.length,
			restarted: restarts.length,
			promoted: promoted.length,
		});
}
