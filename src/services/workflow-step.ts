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
