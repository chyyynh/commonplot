import { Container } from '@cloudflare/containers';

export class ZoteroSdtContainer extends Container<CoreEnv> {
	defaultPort = 8080;
	sleepAfter = '2m';
	enableInternet = false;

	private async ensureReady(input: ReadableStream<Uint8Array>): Promise<void> {
		try {
			await this.startAndWaitForPorts(this.defaultPort, {
				instanceGetTimeoutMS: 30_000,
				portReadyTimeoutMS: 240_000,
				waitInterval: 500,
			});
		} catch (error) {
			await input.cancel('Zotero SDT container failed to become ready');
			throw error;
		}
	}

	async processPdf(input: ReadableStream<Uint8Array>, byteLength: number | null): Promise<Response> {
		await this.ensureReady(input);

		return this.containerFetch('http://zotero-sdt/parse', {
			body: byteLength === null ? input : input.pipeThrough(new FixedLengthStream(byteLength)),
			headers: { 'content-type': 'application/pdf' },
			method: 'POST',
		});
	}

	async renderPdfArea(
		input: ReadableStream<Uint8Array>,
		byteLength: number,
		pageIndex: number,
		rect: readonly [number, number, number, number],
	): Promise<Response> {
		await this.ensureReady(input);
		const query = new URLSearchParams({ pageIndex: String(pageIndex), rect: rect.join(',') });
		return this.containerFetch(`http://zotero-sdt/render-area?${query}`, {
			body: input.pipeThrough(new FixedLengthStream(byteLength)),
			headers: { 'content-type': 'application/pdf' },
			method: 'POST',
		});
	}
}
