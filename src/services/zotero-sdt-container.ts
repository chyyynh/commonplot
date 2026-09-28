import { Container } from '@cloudflare/containers';

async function ensureReady(container: Container<CoreEnv>, context: DurableObjectState, input: ReadableStream<Uint8Array>): Promise<void> {
	try {
		const state = await container.getState();
		if (context.container?.running && state.status === 'healthy') return;
		await container.startAndWaitForPorts(container.defaultPort, {
			instanceGetTimeoutMS: 30_000,
			portReadyTimeoutMS: 240_000,
			waitInterval: 500,
		});
	} catch (error) {
		await input.cancel('PDF container failed to become ready');
		throw error;
	}
}

export class ZoteroSdtContainer extends Container<CoreEnv> {
	defaultPort = 8080;
	sleepAfter = '2m';
	enableInternet = false;

	async processPdf(input: ReadableStream<Uint8Array>, byteLength: number): Promise<Response> {
		await ensureReady(this, this.ctx, input);

		return this.containerFetch('http://zotero-sdt/parse', {
			body: input.pipeThrough(new FixedLengthStream(byteLength)),
			headers: { 'content-type': 'application/pdf' },
			method: 'POST',
		});
	}

	async renderPdfAreas(
		input: ReadableStream<Uint8Array>,
		byteLength: number,
		crops: readonly Readonly<{ id: string; pageIndex: number; rect: readonly [number, number, number, number] }>[],
	): Promise<Response> {
		if (!crops.length || crops.length > 8) {
			await input.cancel('PDF crop batches must contain 1–8 areas');
			throw new Error('PDF crop batches must contain 1–8 areas');
		}
		await ensureReady(this, this.ctx, input);
		return this.containerFetch('http://zotero-sdt/render-areas', {
			body: input.pipeThrough(new FixedLengthStream(byteLength)),
			headers: {
				'content-type': 'application/pdf',
				'x-pdf-crops': JSON.stringify(crops.map(({ id, pageIndex, rect }) => ({ id, pageIndex, rect }))),
			},
			method: 'POST',
		});
	}
}
