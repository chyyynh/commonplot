import { NonRetryableError } from 'cloudflare:workflows';

// How our fetches introduce themselves to sources that ask for a contact.
const CRAWLER_SITE = 'https://www.commonplot.co';
export const CRAWLER_CONTACT = 'hello@commonplot.co';

/** An identifying User-Agent: product token, site and contact inbox. */
export const crawlerUserAgent = (product = 'commonplot') => `${product}/1.0 (+${CRAWLER_SITE}; mailto:${CRAWLER_CONTACT})`;

export function limitByteStream(input: ReadableStream<Uint8Array>, maxBytes: number, error: () => Error): ReadableStream<Uint8Array> {
	let byteLength = 0;
	return input.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				byteLength += chunk.byteLength;
				if (byteLength > maxBytes) throw error();
				controller.enqueue(chunk);
			},
		}),
	);
}

export async function readBoundedResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
	const limitError = `${label} exceeded ${maxBytes} bytes`;
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel(limitError);
		throw new Error(limitError);
	}
	if (!response.body) return '';
	return new Response(limitByteStream(response.body, maxBytes, () => new Error(limitError))).text();
}

/** Statuses a provider documents as permanent: listed, or matched by a predicate. */
type PermanentStatuses = readonly number[] | ((status: number) => boolean);

/** A failed HTTP status's error: permanent statuses never retry, every other one does. */
export function statusError(status: number, permanent: PermanentStatuses, message: string): Error {
	const isPermanent = typeof permanent === 'function' ? permanent(status) : permanent.includes(status);
	return isPermanent ? new NonRetryableError(message) : new Error(message);
}

/** Discard a failed response's body and classify its status. */
export async function responseError(response: Response, permanent: PermanentStatuses, message: string): Promise<Error> {
	await response.body?.cancel();
	return statusError(response.status, permanent, message);
}

type FetchOptions = RequestInit & { label: string; timeoutMs: number; permanent?: PermanentStatuses; missing?: readonly number[] };

/**
 * A provider request that resolves to an ok response. A `missing` status (the provider has no such record) resolves to
 * null; any other failure throws, permanent only for a `permanent` status, and names a `Retry-After` the provider sent.
 */
export async function fetchOk(url: string | URL, options: FetchOptions & { missing: readonly number[] }): Promise<Response | null>;
export async function fetchOk(url: string | URL, options: FetchOptions): Promise<Response>;
export async function fetchOk(url: string | URL, { label, timeoutMs, permanent = [], missing = [], ...init }: FetchOptions) {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	if (response.ok) return response;
	const retryAfter = response.headers.get('retry-after')?.slice(0, 100);
	const error = await responseError(
		response,
		permanent,
		`${label} failed with HTTP ${response.status}${retryAfter ? `; retry_after=${retryAfter}` : ''}`,
	);
	if (missing.includes(response.status)) return null;
	throw error;
}

/** A thrown value's message, for logs and stored errors. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
