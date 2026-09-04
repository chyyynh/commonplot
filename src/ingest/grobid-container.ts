import { Container } from '@cloudflare/containers';
import { type GrobidPdfHeader, parseGrobidPdfHeaderTei } from './grobid-tei.ts';
import { MAX_PDF_BYTES } from './platforms/pdf-constants.ts';

const GROBID_PORT = 8070;
export const GROBID_CONTAINER_NAME = 'citation-parser-v1';
const MAX_ERROR_BODY_CHARS = 1_000;
const MAX_GROBID_RESPONSE_BYTES = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel('GROBID response exceeded byte limit');
		throw new Error(`GROBID response exceeded ${maxBytes} bytes`);
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let byteLength = 0;
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		byteLength += value.byteLength;
		if (byteLength > maxBytes) {
			await reader.cancel('GROBID response exceeded byte limit');
			throw new Error(`GROBID response exceeded ${maxBytes} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function multipartPdfBody(
	pdf: ReadableStream<Uint8Array>,
	boundary: string,
	fields: Readonly<Record<string, string>>,
): {
	byteLengthOverhead: number;
	body: ReadableStream<Uint8Array>;
} {
	const prefix = textEncoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="input"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
	);
	const suffix = textEncoder.encode(
		`${Object.entries(fields)
			.map(([name, value]) => `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`)
			.join('')}\r\n--${boundary}--\r\n`,
	);
	const reader = pdf.getReader();
	let phase: 'pdf' | 'prefix' | 'suffix' = 'prefix';
	return {
		byteLengthOverhead: prefix.byteLength + suffix.byteLength,
		body: new ReadableStream<Uint8Array>({
			async cancel(reason) {
				await reader.cancel(reason);
			},
			async pull(controller) {
				if (phase === 'prefix') {
					phase = 'pdf';
					controller.enqueue(prefix);
					return;
				}
				if (phase === 'pdf') {
					const next = await reader.read();
					if (!next.done) {
						controller.enqueue(next.value);
						return;
					}
					phase = 'suffix';
				}
				controller.enqueue(suffix);
				controller.close();
			},
		}),
	};
}

export class GrobidContainer extends Container<CoreEnv> {
	defaultPort = GROBID_PORT;
	requiredPorts = [GROBID_PORT];
	sleepAfter = '2m';
	enableInternet = false;

	private async processPdfTei(input: ReadableStream<Uint8Array>, byteLength: number): Promise<string> {
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
		const multipart = multipartPdfBody(input, boundary, { consolidateHeader: '0' });
		const body = multipart.body.pipeThrough(new FixedLengthStream(byteLength + multipart.byteLengthOverhead));
		const response = await this.containerFetch('http://grobid/api/processHeaderDocument', {
			body,
			headers: {
				accept: 'application/xml',
				'content-type': `multipart/form-data; boundary=${boundary}`,
			},
			method: 'POST',
		});
		if (!response.ok) {
			const detail = (await boundedResponseText(response, MAX_ERROR_BODY_CHARS)).slice(0, MAX_ERROR_BODY_CHARS);
			throw new Error(`GROBID processHeaderDocument failed with ${response.status}${detail ? `: ${detail}` : ''}`);
		}
		return boundedResponseText(response, MAX_GROBID_RESPONSE_BYTES);
	}

	async processPdfHeader(input: ReadableStream<Uint8Array>, byteLength: number): Promise<GrobidPdfHeader> {
		return parseGrobidPdfHeaderTei(await this.processPdfTei(input, byteLength));
	}
}
