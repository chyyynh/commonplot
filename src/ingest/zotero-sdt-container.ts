import { Container } from '@cloudflare/containers';
import { MAX_PDF_BYTES } from './platforms/pdf-constants.ts';
import { ZOTERO_SDT_MAX_RESPONSE_BYTES } from './zotero-sdt.ts';

const ZOTERO_SDT_PORT = 8080;
const SOURCE_CROP_SCALE = 3;
const MAX_SOURCE_CROPS = 64;
const MAX_SOURCE_CROP_DESCRIPTOR_BYTES = 16 * 1024;

export type PdfRenderArea = Readonly<{
	id: string;
	pageIndex: number;
	rect: readonly [number, number, number, number];
}>;

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

	async renderPdfAreas(input: ReadableStream<Uint8Array>, byteLength: number, areas: readonly PdfRenderArea[]): Promise<Response> {
		if (!input || typeof input.getReader !== 'function') throw new TypeError('Zotero SDT PDF input must be a readable byte stream');
		if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_PDF_BYTES) {
			throw new TypeError(`Zotero SDT PDF must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		if (!areas.length || areas.length > MAX_SOURCE_CROPS) throw new TypeError('Zotero SDT source crop batch size is invalid');
		const ids = new Set<string>();
		for (const area of areas) {
			if (!/^\d+(?:\.\d+)*-p\d+$/u.test(area.id) || ids.has(area.id)) throw new TypeError('Zotero SDT source crop ID is invalid');
			if (!Number.isInteger(area.pageIndex) || area.pageIndex < 0) throw new TypeError('Zotero SDT source crop page is invalid');
			if (
				area.rect.length !== 4 ||
				area.rect.some((part) => !Number.isFinite(part)) ||
				!(area.rect[2] > area.rect[0]) ||
				!(area.rect[3] > area.rect[1])
			) {
				throw new TypeError('Zotero SDT source crop rectangle is invalid');
			}
			ids.add(area.id);
		}
		const descriptors = JSON.stringify(areas.map(({ id, pageIndex, rect }) => [id, pageIndex, ...rect]));
		if (new TextEncoder().encode(descriptors).byteLength > MAX_SOURCE_CROP_DESCRIPTOR_BYTES) {
			throw new TypeError('Zotero SDT source crop descriptors are too large');
		}
		await this.ensureReady(input);
		return this.containerFetch('http://zotero-sdt/render-areas', {
			body: this.requestBody(input, byteLength),
			headers: {
				accept: 'application/vnd.newsence.pdf-crops',
				'content-type': 'application/pdf',
				'x-newsence-pdf-areas': descriptors,
				'x-newsence-pdf-scale': String(SOURCE_CROP_SCALE),
			},
			method: 'POST',
		});
	}
}
