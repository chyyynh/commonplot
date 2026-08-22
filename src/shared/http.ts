export const WEB_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024;

export function limitBody(response: Response, maxBytes = DEFAULT_TEXT_MAX_BYTES): ReadableStream<Uint8Array> | null {
	const contentLengthHeader = response.headers.get('content-length');
	if (contentLengthHeader !== null) {
		const value = contentLengthHeader.trim();
		const contentLength = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(contentLength)) {
			void response.body?.cancel();
			throw new Error(`Invalid Content-Length header: ${contentLengthHeader}`);
		}
		if (contentLength > maxBytes) {
			void response.body?.cancel();
			throw new Error(`Response too large: ${contentLength} bytes`);
		}
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
