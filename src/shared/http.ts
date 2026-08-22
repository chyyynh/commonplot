export const WEB_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024;

async function responseContentLength(response: Response): Promise<number | null> {
	const header = response.headers.get('content-length');
	if (header === null) return null;
	const value = header.trim();
	if (!/^\d+$/.test(value)) {
		await response.body?.cancel();
		throw new Error(`Invalid Content-Length header: ${header}`);
	}
	const length = Number(value);
	if (!Number.isSafeInteger(length)) {
		await response.body?.cancel();
		throw new Error(`Invalid Content-Length header: ${header}`);
	}
	return length;
}

async function responseBodyWithLimit(response: Response, maxBytes: number): Promise<ReadableStream<Uint8Array> | null> {
	const contentLength = await responseContentLength(response);
	if (contentLength !== null && contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error(`Response too large: ${contentLength} bytes`);
	}
	if (!response.body) return null;

	let totalBytes = 0;
	return response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				totalBytes += chunk.byteLength;
				if (totalBytes > maxBytes) {
					throw new Error(`Response body exceeded ${maxBytes} bytes`);
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

export async function readTextWithLimit(response: Response, maxBytes = DEFAULT_TEXT_MAX_BYTES): Promise<string> {
	const body = await responseBodyWithLimit(response, maxBytes);
	return body ? new Response(body).text() : '';
}

export async function readBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
	const body = await responseBodyWithLimit(response, maxBytes);
	return body ? new Response(body).bytes() : new Uint8Array();
}
