import type { WorkflowSleepDuration, WorkflowStep, WorkflowStepConfig, WorkflowStepContext } from 'cloudflare:workers';

/** Step retries for provider fetches; each step sets its own timeout. */
export const FETCH_STEP_RETRIES = { limit: 3, delay: '10 seconds', backoff: 'exponential' } as const;

/** Database reads and writes, queue sends. */
export const STORAGE_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' } as const;

/** A step whose JSON result can exceed the step result limit: the checkpoint holds it as a stream. */
export async function stepJson<T>(
	step: WorkflowStep,
	name: string,
	config: WorkflowStepConfig,
	callback: (ctx: WorkflowStepContext) => Promise<T>,
): Promise<T> {
	const body = await step.do(name, config, async (ctx) => Response.json(await callback(ctx)).body!);
	return new Response(body).json<T>();
}

/**
 * The same step, also adding each `do`'s wall time (retries and their waits included) to `timings`, keyed by its name
 * without the version suffix. A step replayed from its checkpoint after a restart adds about nothing.
 */
export function timedStep(step: WorkflowStep, timings: Record<string, number>): WorkflowStep {
	// The step is an RPC stub: its methods are only ever called on it, never bound or read off it.
	const timed = {
		do: async (name: string, ...rest: unknown[]) => {
			const startedAt = Date.now();
			try {
				return await (step.do as (...args: unknown[]) => Promise<unknown>)(name, ...rest);
			} finally {
				const key = name.replace(/-v\d+(-.*)?$/, '');
				timings[key] = (timings[key] ?? 0) + Date.now() - startedAt;
			}
		},
		sleep: (name: string, duration: WorkflowSleepDuration) => step.sleep(name, duration),
		sleepUntil: (name: string, timestamp: Date | number) => step.sleepUntil(name, timestamp),
		waitForEvent: (name: string, options: Parameters<WorkflowStep['waitForEvent']>[1]) => step.waitForEvent(name, options),
	};
	return timed as unknown as WorkflowStep;
}
