import { Container } from '@cloudflare/containers';

const ZOTERO_SDT_PORT = 8080;

export class ZoteroSdtContainer extends Container<CoreEnv> {
	defaultPort = ZOTERO_SDT_PORT;
	sleepAfter = '2m';
	enableInternet = false;

	private async ensureReady(input: ReadableStream<Uint8Array>): Promise<void> {
		try {
			await this.startAndWaitForPorts({
				ports: ZOTERO_SDT_PORT,
				cancellationOptions: {
					instanceGetTimeoutMS: 30_000,
					portReadyTimeoutMS: 240_000,
					waitInterval: 500,
				},
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
		const url = new URL('http://zotero-sdt/render-area');
		url.searchParams.set('pageIndex', String(pageIndex));
		url.searchParams.set('rect', rect.join(','));
		return this.containerFetch(url, {
			body: input.pipeThrough(new FixedLengthStream(byteLength)),
			headers: { 'content-type': 'application/pdf' },
			method: 'POST',
		});
	}
}
