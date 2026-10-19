import type { WorkflowDynamicDelayContext } from 'cloudflare:workers';
import { z } from 'zod';

export const CORE_TEXT_MODEL = '@cf/zai-org/glm-5.3-flash';

// GLM on Workers AI ignores `reasoning_effort: null` and `enable_thinking: false`: unbounded thinking spends the whole
// output budget and leaves no answer. Low effort keeps the thinking to a few sentences.
export const CORE_TEXT_REASONING = 'low';

export type GatewayMetadata = NonNullable<GatewayOptions['metadata']>;
type AiEnv = Pick<CoreEnv, 'AI' | 'AI_GATEWAY_ENVIRONMENT'>;

/** The longest one model call may take; a hung call otherwise holds its step until the step's own timeout. */
const AI_REQUEST_TIMEOUT_MS = 180_000;

/** Options for one model call, made right before it: the timeout starts here. */
export function coreGatewayOptions(env: Pick<CoreEnv, 'AI_GATEWAY_ENVIRONMENT'>, metadata: GatewayMetadata) {
	return {
		gateway: {
			id: 'core-ingest',
			collectLog: true,
			retries: { maxAttempts: 1 },
			metadata: { ...metadata, environment: env.AI_GATEWAY_ENVIRONMENT },
		} satisfies GatewayOptions,
		extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
	};
}

type ChatRequest = {
	system: string;
	prompt: string;
	temperature: number;
	maxTokens?: number;
	reasoning?: typeof CORE_TEXT_REASONING;
};

const ChatCompletionSchema = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({ content: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish() }),
				finish_reason: z.string().nullish(),
			}),
		)
		.min(1),
	usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).partial().nullish(),
});

/** The reply was capped or did not parse as the requested object. */
export class AiOutputError extends Error {
	override readonly name = 'AiOutputError';
	constructor(
		message: string,
		readonly finishReason: string,
		readonly text: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

/**
 * One chat completion through the ingest gateway. Native models (`@cf/…`) run on Workers AI; catalog slugs
 * (`google/…`) are third-party models the gateway proxies with the OpenAI Chat Completions body.
 */
async function chatCompletion(env: AiEnv, model: string, metadata: GatewayMetadata, request: ChatRequest, responseFormat: object) {
	const body = {
		messages: [
			{ role: 'system', content: request.system },
			{ role: 'user', content: request.prompt },
		],
		temperature: request.temperature,
		...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
		...(request.reasoning ? { reasoning_effort: request.reasoning } : {}),
		response_format: responseFormat,
	};
	const options = coreGatewayOptions(env, metadata);
	let raw: unknown;
	if (model.startsWith('@cf/')) {
		raw = await env.AI.run(model as typeof CORE_TEXT_MODEL, body as never, options);
	} else {
		const response = await env.AI.run(model, body, { ...options, returnRawResponse: true });
		if (!(response instanceof Response)) throw new Error(`AI Gateway returned no response for ${model}`);
		if (!response.ok) throw new Error(`AI Gateway ${model} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
		raw = await response.json();
	}
	const { choices, usage } = ChatCompletionSchema.parse(raw);
	const [{ message, finish_reason }] = choices as [(typeof choices)[number]];
	return {
		text: typeof message.content === 'string' ? message.content : message.content ? JSON.stringify(message.content) : '',
		finishReason: finish_reason === 'model_length' ? 'length' : (finish_reason ?? 'stop'),
		outputTokens: usage?.completion_tokens,
	};
}

/** A zod-validated object from `model`; a capped or malformed reply throws `AiOutputError`. */
export async function generateObject<Schema extends z.ZodType>(
	env: AiEnv,
	model: string,
	metadata: GatewayMetadata,
	{ output, ...request }: ChatRequest & { output: { name: string; description?: string; schema: Schema } },
) {
	const { $schema: _, ...schema } = z.toJSONSchema(output.schema, { target: 'draft-07' });
	// Native Workers AI takes a bare JSON Schema; the gateway's OpenAI-compatible providers take the named envelope.
	const jsonSchema = model.startsWith('@cf/')
		? { title: output.name, ...(output.description ? { description: output.description } : {}), ...schema }
		: { name: output.name, description: output.description, schema, strict: true };
	const result = await chatCompletion(env, model, metadata, request, { type: 'json_schema', json_schema: jsonSchema });
	if (result.finishReason === 'length')
		throw new AiOutputError(`${output.name} hit its output token cap`, result.finishReason, result.text);
	let value: unknown;
	try {
		value = JSON.parse(result.text);
	} catch (error) {
		throw new AiOutputError(`${output.name} is not JSON`, result.finishReason, result.text, { cause: error });
	}
	const parsed = output.schema.safeParse(value);
	if (!parsed.success) {
		throw new AiOutputError(`${output.name} does not match its schema`, result.finishReason, result.text, { cause: parsed.error });
	}
	return { ...result, output: parsed.data as z.output<Schema> };
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
