import { Container } from '@cloudflare/containers';
import { readBoundedResponseText } from '../shared/response.ts';
import { type GrobidPdfHeader, parseGrobidPdfHeaderTei } from './grobid-tei.ts';
import { MAX_PDF_BYTES } from './platforms/pdf-policy.ts';

const MAX_ERROR_BODY_BYTES = 1_000;
const MAX_GROBID_RESPONSE_BYTES = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();

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

function multipartPdfBody(pdf: ReadableStream<Uint8Array>, boundary: string, byteLength: number) {
	const prefix = textEncoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="input"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
	);
	const suffix = textEncoder.encode(
		`\r\n--${boundary}\r\nContent-Disposition: form-data; name="consolidateHeader"\r\n\r\n0\r\n--${boundary}--\r\n`,
	);
	return pdf
		.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				start(controller) {
					controller.enqueue(prefix);
				},
				flush(controller) {
					controller.enqueue(suffix);
				},
			}),
		)
		.pipeThrough(new FixedLengthStream(byteLength + prefix.byteLength + suffix.byteLength));
}

export class GrobidContainer extends Container<CoreEnv> {
	defaultPort = 8070;
	sleepAfter = '2m';
	enableInternet = false;

	async processPdfHeader(input: ReadableStream<Uint8Array>, byteLength: number): Promise<GrobidPdfHeader> {
		if (!input || typeof input.getReader !== 'function') throw new TypeError('GROBID PDF input must be a readable byte stream');
		if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_PDF_BYTES) {
			await input.cancel('GROBID PDF size is outside the supported range');
			throw new TypeError(`GROBID PDF must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		await ensureReady(this, this.ctx, input);

		const boundary = `newsence-${crypto.randomUUID()}`;
		const response = await this.containerFetch('http://grobid/api/processHeaderDocument', {
			body: multipartPdfBody(input, boundary, byteLength),
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			method: 'POST',
		});
		const text = await readBoundedResponseText(response, response.ok ? MAX_GROBID_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES, 'GROBID response');
		if (!response.ok) throw new Error(`GROBID processHeaderDocument failed with ${response.status}${text ? `: ${text}` : ''}`);
		return parseGrobidPdfHeaderTei(text);
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
