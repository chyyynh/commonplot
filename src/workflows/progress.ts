import type { WorkflowStep } from 'cloudflare:workers';

export type ProgressReport = {
	taskId: string;
	stage?: 'acquiring' | 'parsing' | 'analyzing' | 'persisting' | 'translating';
	status: 'queued' | 'running' | 'complete' | 'failed' | 'skipped' | 'superseded';
	resourceId?: string;
	completed?: number;
	total?: number;
	errorCode?: string;
};

const PROGRESS_STEP = { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;
/** One execution policy, shared by the Workflow and every follow-up it admits. */
export function createResourceTask(env: CoreEnv, step: WorkflowStep, taskId: string, required: boolean) {
	// Deliveries leave in call order, so the Workflow can announce a stage without waiting on it.
	let queue: Promise<unknown> = Promise.resolve();
	const send = (name: string, deliver: () => Promise<boolean>) => {
		const sent = queue.then(() => step.do(name, PROGRESS_STEP, deliver));
		queue = sent.catch(() => {});
		return sent;
	};
	return {
		taskId,
		required,
		start(stage: NonNullable<ProgressReport['stage']>) {
			if (!required) return Promise.resolve(true);
			return send('start-resource-progress-v1', () => env.APP.startResourceProgressTask(taskId, stage));
		},
		/** A report only informs the reader, so an undeliverable one is logged instead of failing the import. */
		report(key: string, report: Omit<ProgressReport, 'taskId'>) {
			if (!required) return Promise.resolve();
			// Delivery retries remain separate from paid provider work.
			return send(`progress-${key}-v1`, () => env.APP.reportResourceProgress({ ...report, taskId })).then(
				() => {},
				(error: unknown) => {
					console.error({ tag: 'WORKFLOW', msg: 'Progress report undelivered', task_id: taskId, report: key, error });
				},
			);
		},
		seal(errorCode?: string) {
			if (!required) return Promise.resolve();
			return send('seal-resource-progress-v1', () => env.APP.sealResourceProgressTask(taskId, errorCode)).then(() => {});
		},
	};
}

export type ResourceTask = ReturnType<typeof createResourceTask>;
export type ResourceTaskContext = Pick<ResourceTask, 'taskId' | 'required'>;
