import { Container } from '@cloudflare/containers';
import { MAX_PDF_BYTES } from './platforms/pdf-constants.ts';
import { ZOTERO_SDT_MAX_RESPONSE_BYTES } from './zotero-sdt.ts';

const ZOTERO_SDT_PORT = 8080;
export const ZOTERO_SDT_CONTAINER_NAME = 'structured-pdf-v1';

export class ZoteroSdtContainer extends Container<CoreEnv> {
	defaultPort = ZOTERO_SDT_PORT;
	requiredPorts = [ZOTERO_SDT_PORT];
	sleepAfter = '2m';
	enableInternet = false;

	override onStart(): void {
		console.info({ event: 'zotero_sdt_container_started', tag: 'ZOTERO_SDT' });
	}

	override onStop(): void {
		console.info({ event: 'zotero_sdt_container_stopped', tag: 'ZOTERO_SDT' });
	}

	override onError(error: unknown): void {
		console.error({ error, event: 'zotero_sdt_container_error', tag: 'ZOTERO_SDT' });
	}

	async processPdf(input: ReadableStream<Uint8Array>, byteLength: number): Promise<Response> {
		if (!input || typeof input.getReader !== 'function') throw new TypeError('Zotero SDT PDF input must be a readable byte stream');
		if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_PDF_BYTES) {
			throw new TypeError(`Zotero SDT PDF must contain 1-${MAX_PDF_BYTES} bytes`);
		}
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

		const response = await this.containerFetch('http://zotero-sdt/parse', {
			body: input,
			headers: {
				accept: 'application/vnd.newsence.structured-document+json',
				'content-length': String(byteLength),
				'content-type': 'application/pdf',
			},
			method: 'POST',
		});
		if (!response.ok) return response;
		const declaredLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(declaredLength) && declaredLength > ZOTERO_SDT_MAX_RESPONSE_BYTES) {
			await response.body?.cancel('Zotero SDT response exceeded byte limit');
			throw new Error(`Zotero SDT response exceeded ${ZOTERO_SDT_MAX_RESPONSE_BYTES} bytes`);
		}
		return response;
	}
}
