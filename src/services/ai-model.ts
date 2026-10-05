import type { WorkflowDynamicDelayContext } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';

const CORE_TEXT_MODEL = '@cf/zai-org/glm-5.3-flash';

// GLM on Workers AI ignores `reasoning_effort: null` and `enable_thinking: false`: unbounded thinking spends the whole
// output budget and leaves no answer. Low effort keeps the thinking to a few sentences.
export const CORE_TEXT_REASONING = 'low';

export function coreGatewayOptions(env: Pick<CoreEnv, 'AI_GATEWAY_ENVIRONMENT'>, metadata: NonNullable<GatewayOptions['metadata']>) {
	return {
		gateway: {
			id: 'core-ingest',
			collectLog: true,
			retries: { maxAttempts: 1 },
			metadata: { ...metadata, environment: env.AI_GATEWAY_ENVIRONMENT },
		} satisfies GatewayOptions,
		extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
	};
}

/** Core's text model, logged through the ingest gateway under `metadata`. */
export function coreTextModel(env: Pick<CoreEnv, 'AI' | 'AI_GATEWAY_ENVIRONMENT'>, metadata: NonNullable<GatewayOptions['metadata']>) {
	return createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, coreGatewayOptions(env, metadata));
}

const AI_RATE_LIMIT_ERROR = /\b(?:3021|3040|429)\b|rate limit|too many requests|capacity temporarily exceeded/iu;

export function aiRetryDelay({ ctx, error }: WorkflowDynamicDelayContext): number {
	// Delay already scales with attempt; use constant Workflow backoff to avoid multiplying it again.
	// The provider's RPM window is one minute. Short exponential retries all land inside the same exhausted window,
	// especially when a source cron starts several translations together. Waiting durably costs no active Worker time.
	if (AI_RATE_LIMIT_ERROR.test(error.message)) return ctx.attempt * 60_000;
	return ctx.attempt * 15_000;
}

/** Step retries for Workers AI calls: waits past the per-minute rate window. */
export const AI_STEP_RETRIES = { limit: 5, delay: aiRetryDelay, backoff: 'constant' } as const;
export const AI_STEP = { retries: AI_STEP_RETRIES, timeout: '600 seconds' } as const;
