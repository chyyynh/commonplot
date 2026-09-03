import { Container } from '@cloudflare/containers';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export class ZoteroSdtContainer extends Container {
	defaultPort = 8080;
	sleepAfter = '2m';

	override onStart() {
		console.info({ event: 'zotero_sdt_container_started' });
	}

	override onStop() {
		console.info({ event: 'zotero_sdt_container_stopped' });
	}

	override onError(error: unknown) {
		console.error({ error, event: 'zotero_sdt_container_error' });
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') {
			return await env.ZOTERO_SDT.getByName('parser').fetch(new Request('http://container/health'));
		}
		if (request.method !== 'POST' || url.pathname !== '/parse') {
			return Response.json({ error: 'Not found.' }, { status: 404 });
		}
		if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')) {
			return Response.json({ error: 'Content-Type must be application/pdf.' }, { status: 415 });
		}
		const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
		if (contentLength > MAX_PDF_BYTES) {
			return Response.json({ error: `PDF exceeds the ${MAX_PDF_BYTES}-byte spike limit.` }, { status: 413 });
		}

		const containerRequest = new Request('http://container/parse', {
			body: request.body,
			headers: request.headers,
			method: request.method,
		});
		return await env.ZOTERO_SDT.getByName('parser').fetch(containerRequest);
	},
} satisfies ExportedHandler<ZoteroSdtBindings>;
