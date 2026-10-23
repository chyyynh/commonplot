import type { WorkflowStep, WorkflowStepConfig, WorkflowStepContext } from 'cloudflare:workers';

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
	const run = step.do.bind(step) as (...args: unknown[]) => Promise<unknown>;
	const timed = {
		do: async (name: string, ...rest: unknown[]) => {
			const startedAt = Date.now();
			try {
				return await run(name, ...rest);
			} finally {
				const key = name.replace(/-v\d+(-.*)?$/, '');
				timings[key] = (timings[key] ?? 0) + Date.now() - startedAt;
			}
		},
		sleep: step.sleep,
		sleepUntil: step.sleepUntil,
		waitForEvent: step.waitForEvent.bind(step),
	};
	return timed as unknown as WorkflowStep;
}
