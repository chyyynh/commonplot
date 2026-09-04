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
