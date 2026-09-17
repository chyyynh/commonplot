import type { WorkflowStep } from 'cloudflare:workers';
import { sha256Hex } from '../shared/hash';

export type ProgressReport = {
	taskId: string;
	stage?: 'acquiring' | 'parsing' | 'images' | 'metadata' | 'analyzing' | 'persisting' | 'translating' | 'references' | 'indexing';
	status: 'queued' | 'running' | 'complete' | 'failed' | 'skipped' | 'superseded';
	resourceId?: string;
	completed?: number;
	total?: number;
	errorCode?: string;
};

const PROGRESS_STEP = { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
/** One execution policy, shared by the Workflow and every follow-up it admits. */
export function createResourceTask(env: CoreEnv, step: WorkflowStep, taskId: string, required = true) {
	// Managed imports can never opt out of their admission/start gate.
	if (taskId.startsWith('app-ingest-v1-')) required = true;
	return {
		taskId,
		required,
		start(stage: NonNullable<ProgressReport['stage']>) {
			if (!required) return Promise.resolve(true);
			return step.do('start-resource-progress-v1', PROGRESS_STEP, () => env.APP.startResourceProgressTask(taskId, stage));
		},
		report(key: string, report: Omit<ProgressReport, 'taskId'>) {
			if (!required) return Promise.resolve();
			// Delivery retries remain separate from paid provider work.
			return step.do(`progress-${key}-v1`, PROGRESS_STEP, async () => {
				await env.APP.reportResourceProgress({ ...report, taskId });
			});
		},
		seal(errorCode?: string) {
			if (!required) return Promise.resolve();
			return step.do('seal-resource-progress-v1', PROGRESS_STEP, async () => {
				await env.APP.sealResourceProgressTask(taskId, errorCode);
			});
		},
	};
}

export type ResourceTask = ReturnType<typeof createResourceTask>;
export type ResourceTaskContext = Pick<ResourceTask, 'taskId' | 'required'>;

export async function registerResourceTask(
	env: CoreEnv,
	input: Omit<Parameters<CoreEnv['APP']['registerResourceProgressTask']>[0], 'parentTaskId'>,
	parent: ResourceTaskContext | undefined,
) {
	// Ordinary descendants only report when their parent has a task ledger.
	if (!parent?.required) return false;
	return env.APP.registerResourceProgressTask({ ...input, parentTaskId: parent.taskId });
}

export async function enqueueSearchProgress(env: CoreEnv, resourceId: string, parent: ResourceTaskContext, revision: string) {
	if (!parent.required) {
		await env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId });
		return;
	}
	const taskId = `index-${await sha256Hex(`${parent.taskId}:${resourceId}:${revision}`)}`;
	await registerResourceTask(env, { taskId, kind: 'index', resourceId }, parent);
	await env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId, taskId });
}
