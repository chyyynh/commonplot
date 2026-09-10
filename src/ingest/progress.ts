import type { WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
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

const PROGRESS_STEP = { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
const OPTIONAL_PROGRESS_TIMEOUT_MS = 1_000;

/** Optional shared-translation delivery must not turn an app outage into failed provider work. */
async function deliverProgress<T>(taskId: string, required: boolean, action: () => Promise<T>): Promise<T | undefined> {
	if (required) return action();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			action(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error('Optional progress delivery timed out')), OPTIONAL_PROGRESS_TIMEOUT_MS);
			}),
		]);
	} catch (error) {
		console.warn({
			tag: 'RESOURCE_TASK',
			event: 'optional_progress_unavailable',
			task_id: taskId,
			error: error instanceof Error ? error.name : 'Unknown',
		});
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export function reportResourceTask(env: CoreEnv, report: ProgressReport, required = true) {
	return deliverProgress(report.taskId, required, () => env.APP.reportResourceProgress(report));
}

export function sealResourceTask(env: CoreEnv, taskId: string, errorCode?: string, required = true) {
	return deliverProgress(taskId, required, () => env.APP.sealResourceProgressTask(taskId, errorCode));
}

/** One execution policy, shared by the Workflow and every follow-up it admits. */
export function createResourceTask(
	env: CoreEnv,
	step: WorkflowStep,
	taskId: string,
	delivery: 'required' | 'optional' | 'none' = 'required',
) {
	// Managed imports can never opt out of their admission/start gate.
	if (taskId.startsWith('app-ingest-v1-')) delivery = 'required';
	const required = delivery === 'required';
	return {
		taskId,
		required,
		start(stage: NonNullable<ProgressReport['stage']>) {
			return step.do('start-resource-progress-v1', PROGRESS_STEP, () =>
				required ? env.APP.startResourceProgressTask(taskId, stage) : Promise.resolve(true),
			);
		},
		report(key: string, report: Omit<ProgressReport, 'taskId'>) {
			// Delivery retries remain separate from paid provider work.
			return step.do(`progress-${key}-v1`, PROGRESS_STEP, async () => {
				if (delivery !== 'none') await reportResourceTask(env, { ...report, taskId }, required);
			});
		},
		seal(errorCode?: string) {
			return step.do('seal-resource-progress-v1', PROGRESS_STEP, async () => {
				if (delivery !== 'none') await sealResourceTask(env, taskId, errorCode, required);
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
	// Monitoring does not create user task ledgers. A late shared-translation
	// subscriber registers a projection with native reconciliation instead.
	if (!parent?.required) return false;
	return env.APP.registerResourceProgressTask({ ...input, parentTaskId: parent.taskId });
}

export async function enqueueSearchProgress(env: CoreEnv, resourceId: string, parent: ResourceTaskContext, revision: string) {
	if (!parent.required) {
		await env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId });
		return;
	}
	const taskId = `index-${await sha256Hex(`${parent.taskId}:${resourceId}:${revision}`)}`;
	await registerResourceTask(env, { taskId, kind: 'index', resourceId, revision }, parent);
	await env.RESOURCE_SEARCH_SYNC_QUEUE.send({ resourceId, taskId });
}

export const ResourceTaskStatusInputSchema = z.strictObject({
	taskId: z.string().min(1).max(150),
	kind: z.literal('translation'),
});
export const ResourceTaskOutcomeSchema = z.strictObject({
	status: z.enum(['complete', 'failed', 'skipped', 'superseded']),
	resourceId: z.uuid().optional(),
	errorCode: z
		.string()
		.regex(/^[a-z0-9_-]{1,80}$/u)
		.optional(),
});
export type ResourceTaskOutcome = z.infer<typeof ResourceTaskOutcomeSchema>;

/** Sparse recovery for shared tasks born without a user's required progress delivery. */
export async function readResourceTaskStatus(env: CoreEnv, input: z.infer<typeof ResourceTaskStatusInputSchema>) {
	const { taskId } = ResourceTaskStatusInputSchema.parse(input);
	const snapshot = await (await env.RESOURCE_TRANSLATION_V2_WORKFLOW.get(taskId)).status();
	if (snapshot.status === 'complete') {
		const outcome = ResourceTaskOutcomeSchema.safeParse(snapshot.output);
		return outcome.success ? outcome.data : { status: 'complete' as const, errorCode: 'native_outcome_unavailable' };
	}
	if (snapshot.status === 'errored' || snapshot.status === 'terminated')
		return {
			status: 'failed' as const,
			errorCode: snapshot.status === 'terminated' ? 'native_workflow_terminated' : 'native_workflow_failed',
		};
	if (snapshot.status === 'unknown') return null;
	return { status: snapshot.status === 'queued' ? ('queued' as const) : ('running' as const) };
}
