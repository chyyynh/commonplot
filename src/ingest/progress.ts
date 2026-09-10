import type { WorkflowStep } from 'cloudflare:workers';
import { sha256Hex } from '../shared/hash';

export type ProgressReport = {
	taskId: string;
	stage?: 'acquiring' | 'parsing' | 'images' | 'metadata' | 'analyzing' | 'persisting' | 'translating' | 'references' | 'indexing';
	status: 'queued' | 'running' | 'complete' | 'failed' | 'skipped' | 'superseded';
	resourceId?: string;
	revision?: string;
	completed?: number;
	total?: number;
	errorCode?: string;
};

/** Persist progress in its own durable step so delivery retries never repeat provider work. */
export function progressStep(env: CoreEnv, step: WorkflowStep, key: string, report: ProgressReport) {
	return step.do(`progress-${key}-v1`, { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
		env.APP.reportResourceProgress(report),
	);
}

export function sealProgressTask(env: CoreEnv, step: WorkflowStep, taskId: string, errorCode?: string) {
	return step.do(
		'seal-resource-progress-v1',
		{ retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		() => env.APP.sealResourceProgressTask(taskId, errorCode),
	);
}

export async function enqueueSearchProgress(env: CoreEnv, resourceId: string, parentTaskId: string, revision: string) {
	const taskId = `index-${await sha256Hex(`${parentTaskId}:${resourceId}:${revision}`)}`;
	await env.APP.registerResourceProgressTask({ taskId, kind: 'index', parentTaskId, resourceId, revision });
	await env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId, taskId });
	return taskId;
}

/** Atomically claim queued work before providers run; expired/replaced admissions cannot restart later. */
export function startProgressTask(env: CoreEnv, step: WorkflowStep, taskId: string, stage: NonNullable<ProgressReport['stage']>) {
	return step.do(
		'start-resource-progress-v1',
		{ retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		() => env.APP.startResourceProgressTask(taskId, stage),
	);
}
