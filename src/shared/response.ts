export async function readBoundedResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
	const limitError = `${label} exceeded ${maxBytes} bytes`;
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel(limitError);
		throw new Error(limitError);
	}
	if (!response.body) return '';
	let byteLength = 0;
	return new Response(
		response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					byteLength += chunk.byteLength;
					if (byteLength > maxBytes) throw new Error(limitError);
					controller.enqueue(chunk);
				},
			}),
		),
	).text();
}
