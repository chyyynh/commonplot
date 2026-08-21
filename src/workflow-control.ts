import type { WorkflowDelayFunction } from 'cloudflare:workers';

const durableWorkflowRetryDelay: WorkflowDelayFunction = ({ ctx }) =>
	ctx.attempt <= 5 ? '10 seconds' : ctx.attempt <= 60 ? '1 minute' : '15 minutes';

export const DURABLE_WORKFLOW_RETRIES = {
	limit: 10_000,
	delay: durableWorkflowRetryDelay,
} as const;

export function workflowOutputWasSuperseded(output: unknown): boolean {
	return typeof output === 'object' && output !== null && 'status' in output && output.status === 'superseded';
}

export function shouldReconcileSupersededRefresh(acquiredSourceRevision: string, currentSourceRevision: string | null): boolean {
	return acquiredSourceRevision !== currentSourceRevision;
}

export async function enqueueOrRestartWorkflow<Params>(workflow: Workflow<Params>, id: string, params: Params): Promise<string> {
	const [created] = await workflow.createBatch([{ id, params }]);
	if (created) return created.id;
	const instance = await workflow.get(id);
	const { output, status } = await instance.status();
	if (status === 'unknown') throw new Error(`Workflow ${id} has unknown status`);
	const rejected =
		status === 'complete' && typeof output === 'object' && output !== null && 'status' in output && output.status === 'rejected';
	if (status === 'errored' || rejected) await instance.restart();
	return instance.id;
}
