import { Container } from '@cloudflare/containers';
import { MAX_PDF_BYTES } from './platforms/pdf-constants.ts';
import { ZOTERO_SDT_MAX_RESPONSE_BYTES } from './zotero-sdt.ts';

const ZOTERO_SDT_PORT = 8080;
const SOURCE_CROP_SCALE = 3;

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

	private requestBody(input: ReadableStream<Uint8Array>, byteLength: number | null): ReadableStream<Uint8Array> {
		return byteLength === null ? input : input.pipeThrough(new FixedLengthStream(byteLength));
	}

	async processPdf(input: ReadableStream<Uint8Array>, byteLength: number | null): Promise<Response> {
		if (!input || typeof input.getReader !== 'function') throw new TypeError('Zotero SDT PDF input must be a readable byte stream');
		if (byteLength !== null && (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_PDF_BYTES)) {
			throw new TypeError(`Zotero SDT PDF must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		await this.ensureReady(input);

		const response = await this.containerFetch('http://zotero-sdt/parse', {
			body: this.requestBody(input, byteLength),
			headers: {
				accept: 'application/vnd.newsence.structured-document+json',
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

	async renderPdfArea(
		input: ReadableStream<Uint8Array>,
		byteLength: number,
		pageIndex: number,
		rect: readonly [number, number, number, number],
	): Promise<Response> {
		if (!input || typeof input.getReader !== 'function') throw new TypeError('Zotero SDT PDF input must be a readable byte stream');
		if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_PDF_BYTES) {
			throw new TypeError(`Zotero SDT PDF must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new TypeError('Zotero SDT source crop page is invalid');
		if (rect.some((part) => !Number.isFinite(part)) || !(rect[2] > rect[0]) || !(rect[3] > rect[1])) {
			throw new TypeError('Zotero SDT source crop rectangle is invalid');
		}
		await this.ensureReady(input);
		const url = new URL('http://zotero-sdt/render-area');
		url.searchParams.set('pageIndex', String(pageIndex));
		url.searchParams.set('rect', rect.join(','));
		url.searchParams.set('scale', String(SOURCE_CROP_SCALE));
		return this.containerFetch(url, {
			body: this.requestBody(input, byteLength),
			headers: {
				accept: 'image/png',
				'content-type': 'application/pdf',
			},
			method: 'POST',
		});
	}
}
