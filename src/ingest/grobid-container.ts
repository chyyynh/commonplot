import { Container } from '@cloudflare/containers';
import { readBoundedResponseText } from '../shared/response.ts';
import { type GrobidPdfHeader, parseGrobidPdfHeaderTei } from './grobid-tei.ts';
import { MAX_PDF_BYTES } from './platforms/pdf-constants.ts';

const GROBID_PORT = 8070;
export const GROBID_CONTAINER_NAME = 'citation-parser-v1';
const MAX_ERROR_BODY_BYTES = 1_000;
const MAX_GROBID_RESPONSE_BYTES = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();

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
				transform(chunk, controller) {
					controller.enqueue(chunk);
				},
				flush(controller) {
					controller.enqueue(suffix);
				},
			}),
		)
		.pipeThrough(new FixedLengthStream(byteLength + prefix.byteLength + suffix.byteLength));
}

export class GrobidContainer extends Container<CoreEnv> {
	defaultPort = GROBID_PORT;
	sleepAfter = '2m';
	enableInternet = false;

	async processPdfHeader(input: ReadableStream<Uint8Array>, byteLength: number): Promise<GrobidPdfHeader> {
		if (!input || typeof input.getReader !== 'function') throw new TypeError('GROBID PDF input must be a readable byte stream');
		if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_PDF_BYTES) {
			throw new TypeError(`GROBID PDF must contain 1-${MAX_PDF_BYTES} bytes`);
		}
		try {
			await this.startAndWaitForPorts({
				ports: GROBID_PORT,
				cancellationOptions: {
					instanceGetTimeoutMS: 30_000,
					portReadyTimeoutMS: 240_000,
					waitInterval: 500,
				},
			});
		} catch (error) {
			await input.cancel('GROBID container failed to become ready');
			throw error;
		}

		const boundary = `newsence-${crypto.randomUUID()}`;
		const response = await this.containerFetch('http://grobid/api/processHeaderDocument', {
			body: multipartPdfBody(input, boundary, byteLength),
			headers: {
				accept: 'application/xml',
				'content-type': `multipart/form-data; boundary=${boundary}`,
			},
			method: 'POST',
		});
		if (!response.ok) {
			const detail = await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES, 'GROBID response');
			throw new Error(`GROBID processHeaderDocument failed with ${response.status}${detail ? `: ${detail}` : ''}`);
		}
		return parseGrobidPdfHeaderTei(await readBoundedResponseText(response, MAX_GROBID_RESPONSE_BYTES, 'GROBID response'));
	}
}
