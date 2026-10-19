import { NonRetryableError } from 'cloudflare:workflows';

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

/** A thrown value's message, for logs and stored errors. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
