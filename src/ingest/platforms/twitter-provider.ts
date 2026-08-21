import { fetchWithTimeout } from '@core-shared/http';
import { shouldRetryTwitterProviderStatus, twitterProviderRetryDelayMs } from './twitter-data';

const TWITTER_PROVIDER_MAX_ATTEMPTS = 3;

type TwitterProviderRequestContext = {
	operation: 'advanced-search' | 'article' | 'thread-context' | 'tweets-by-id';
	resourceId?: string;
	timeoutMs?: number;
};

async function waitForTwitterProviderRetry(input: {
	attempt: number;
	context: TwitterProviderRequestContext;
	error?: unknown;
	response?: Response;
}): Promise<void> {
	const delayMs = twitterProviderRetryDelayMs(input.response?.headers.get('retry-after') ?? null, input.attempt);
	console.warn({
		tag: 'TWITTER',
		event: 'provider_request_retry',
		operation: input.context.operation,
		...(input.context.resourceId ? { resource_id: input.context.resourceId } : {}),
		attempt: input.attempt,
		next_attempt: input.attempt + 1,
		delay_ms: delayMs,
		...(input.response ? { status: input.response.status } : {}),
		...(input.error ? { error: input.error instanceof Error ? input.error.message : String(input.error) } : {}),
	});
	await scheduler.wait(delayMs);
}

/** Bounded retry transport for transient twitterapi.io HTTP and network failures. */
export async function fetchTwitterProvider(
	url: string | URL,
	apiKey: string,
	context: TwitterProviderRequestContext,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('x-api-key', apiKey);

	for (let attempt = 1; attempt <= TWITTER_PROVIDER_MAX_ATTEMPTS; attempt++) {
		let response: Response;
		try {
			response = await fetchWithTimeout(url.toString(), { ...init, headers }, context.timeoutMs ?? 20_000);
		} catch (error) {
			if (attempt === TWITTER_PROVIDER_MAX_ATTEMPTS) throw error;
			await waitForTwitterProviderRetry({ attempt, context, error });
			continue;
		}

		if (!shouldRetryTwitterProviderStatus(response.status) || attempt === TWITTER_PROVIDER_MAX_ATTEMPTS) return response;
		await response.body?.cancel().catch(() => undefined);
		await waitForTwitterProviderRetry({ attempt, context, response });
	}

	throw new Error(`Twitter provider ${context.operation} exhausted retry attempts`);
}
