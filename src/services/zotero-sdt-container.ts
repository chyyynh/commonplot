import { DurableObject } from 'cloudflare:workers';
import { errorMessage } from './response.ts';

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const READY_TIMEOUT_MS = 240_000;
const READY_POLL_MS = 500;
const PING_TIMEOUT_MS = 5_000;

/** Durable Object-scheduled Zotero document-worker. Each call streams one R2 PDF into the container. */
export class ZoteroSdt extends DurableObject<CoreEnv> {
	constructor(ctx: DurableObjectState, env: CoreEnv) {
		super(ctx, env);
		// Inactivity timeouts do not survive a Durable Object restart.
		const container = ctx.container;
		if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
	}

	async processPdf(input: ReadableStream<Uint8Array>, byteLength: number): Promise<Response> {
		const port = await this.ensureReady(input, 'parse', byteLength);
		return timed('parse', byteLength, () =>
			port.fetch('http://zotero-sdt/parse', {
				body: input.pipeThrough(new FixedLengthStream(byteLength)),
				headers: { 'content-type': 'application/pdf' },
				method: 'POST',
			}),
		);
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
		const port = await this.ensureReady(input, 'render-areas', byteLength);
		return timed('render-areas', byteLength, () =>
			port.fetch('http://zotero-sdt/render-areas', {
				body: input.pipeThrough(new FixedLengthStream(byteLength)),
				headers: {
					'content-type': 'application/pdf',
					'x-pdf-crops': JSON.stringify(crops.map(({ id, pageIndex, rect }) => ({ id, pageIndex, rect }))),
				},
				method: 'POST',
			}),
		);
	}

	private async ensureReady(input: ReadableStream<Uint8Array>, operation: PdfOperation, byteLength: number): Promise<Fetcher> {
		const startedAt = Date.now();
		const coldStart = !this.ctx.container?.running;
		try {
			const container = this.ctx.container;
			if (!container) throw new Error('ZoteroSdt has no attached container');
			if (coldStart) {
				// `basic` is not a runtime instance size; `lite` (256 MiB) cannot hold PDF.js and canvas.
				container.start({ enableInternet: false, image: container.images['zotero-sdt'], instance: 'standard-1' });
				this.ctx.waitUntil(
					container.monitor().then(
						() => console.info({ tag: 'PDF_PARSE', event: 'zotero_sdt_container_exited' }),
						(error: unknown) =>
							console.error({
								tag: 'PDF_PARSE',
								event: 'zotero_sdt_container_crashed',
								error: errorMessage(error),
								exit_code: (error as { exitCode?: number } | null)?.exitCode ?? null,
							}),
					),
				);
				await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
			}
			const port = container.getTcpPort(PORT);
			await waitForPort(container, port);
			console.info({
				tag: 'PDF_PARSE',
				event: 'zotero_sdt_container_ready',
				operation,
				cold_start: coldStart,
				ready_ms: Date.now() - startedAt,
				byte_length: byteLength,
			});
			return port;
		} catch (error) {
			console.error({
				tag: 'PDF_PARSE',
				event: 'zotero_sdt_container_not_ready',
				operation,
				cold_start: coldStart,
				waited_ms: Date.now() - startedAt,
				error: errorMessage(error),
			});
			await input.cancel('PDF container failed to become ready');
			throw error;
		}
	}
}

type PdfOperation = 'parse' | 'render-areas';

/** Time to response headers; the server answers only after the whole document is processed. */
async function timed(operation: PdfOperation, byteLength: number, request: () => Promise<Response>): Promise<Response> {
	const startedAt = Date.now();
	const response = await request();
	console.info({
		tag: 'PDF_PARSE',
		event: 'zotero_sdt_request_completed',
		operation,
		status: response.status,
		duration_ms: Date.now() - startedAt,
		byte_length: byteLength,
	});
	return response;
}

/** `start()` returns before the server listens; any HTTP response (the server 404s pings) means it is ready. */
async function waitForPort(container: Container, port: Fetcher): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		try {
			const response = await port.fetch('http://zotero-sdt/ping', { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
			await response.body?.cancel();
			return;
		} catch (error) {
			const reason = errorMessage(error);
			if (!container.running) throw new Error(`PDF container exited before it became ready: ${reason}`);
			if (Date.now() >= deadline) throw new Error(`PDF container did not become ready: ${reason}`);
			await scheduler.wait(READY_POLL_MS);
		}
	}
}
