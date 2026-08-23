import { LLAMAPARSE_V2_RESULT_EXPAND, type SelectiveLlamaParseV2Configuration } from './pdf-enhancement.ts';

const LLAMACLOUD_API_ORIGIN = 'https://api.cloud.llamaindex.ai';
const MAX_PDF_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_RESPONSE_BYTES = 128 * 1024;
const MAX_PARSE_RESULT_BYTES = 16 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const RESULT_TIMEOUT_MS = 60_000;

type LlamaParseFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RetrySafety = 'safe' | 'reconcile-required';

export type LlamaParseJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type LlamaParseFileReference = Readonly<{
	id: string;
	name: string;
	projectId: string;
	purpose: 'parse';
}>;

export type LlamaParseJobReference = Readonly<{
	id: string;
	projectId: string;
	status: LlamaParseJobStatus;
	tier: string | null;
}>;

export class LlamaParseClientError extends Error {
	readonly operation: string;
	readonly status: number | null;
	readonly retryable: boolean;
	readonly requestId: string | null;
	readonly retryAfterSeconds: number | null;

	constructor(input: {
		message: string;
		operation: string;
		status?: number | null;
		retryable?: boolean;
		requestId?: string | null;
		retryAfterSeconds?: number | null;
	}) {
		super(input.message);
		this.name = 'LlamaParseClientError';
		this.operation = input.operation;
		this.status = input.status ?? null;
		this.retryable = input.retryable ?? false;
		this.requestId = input.requestId ?? null;
		this.retryAfterSeconds = input.retryAfterSeconds ?? null;
	}
}

export type LlamaParseClient = Readonly<{
	uploadPdf(pdf: Blob): Promise<LlamaParseFileReference>;
	createParse(fileId: string, configuration: SelectiveLlamaParseV2Configuration): Promise<LlamaParseJobReference>;
	getParseJob(jobId: string): Promise<LlamaParseJobReference>;
	getParseResult(jobId: string): Promise<unknown>;
	cancelParse(jobId: string): Promise<LlamaParseJobReference>;
	deleteFile(fileId: string): Promise<void>;
}>;

export type LlamaParseClientOptions = Readonly<{
	apiKey: string;
	projectId?: string;
	organizationId?: string;
	fetcher?: LlamaParseFetch;
}>;

function safeToken(value: string, label: string): string {
	const token = value.trim();
	if (!token || token.length > 1_000 || !/^[\x21-\x7e]+$/.test(token)) throw new TypeError(`${label} is invalid`);
	return token;
}

function safeIdentifier(value: string, label: string): string {
	const identifier = value.trim();
	const hasControlCharacter = [...identifier].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
	});
	if (!identifier || identifier.length > 200 || hasControlCharacter) throw new TypeError(`${label} is invalid`);
	return identifier;
}

function responseRequestId(response: Response): string | null {
	for (const name of ['x-request-id', 'x-correlation-id', 'cf-ray']) {
		const value = response.headers.get(name)?.trim();
		if (value && value.length <= 128 && /^[\x20-\x7e]+$/.test(value)) return value;
	}
	return null;
}

function retryAfterSeconds(response: Response): number | null {
	const value = response.headers.get('retry-after')?.trim();
	if (!value) return null;
	if (/^\d+$/.test(value)) {
		const seconds = Number(value);
		return Number.isSafeInteger(seconds) ? seconds : null;
	}
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : null;
}

function transientHttpStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function providerRecord(value: unknown, operation: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new LlamaParseClientError({ message: `LlamaParse ${operation} returned an invalid response`, operation });
	}
	return value as Record<string, unknown>;
}

function providerString(value: unknown, operation: string, field: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 3_000) {
		throw new LlamaParseClientError({ message: `LlamaParse ${operation} returned an invalid ${field}`, operation });
	}
	return value.trim();
}

function providerIdentifier(value: unknown, operation: string, field: string): string {
	const identifier = providerString(value, operation, field);
	try {
		return safeIdentifier(identifier, field);
	} catch {
		throw new LlamaParseClientError({ message: `LlamaParse ${operation} returned an invalid ${field}`, operation });
	}
}

function parseFileReference(value: unknown): LlamaParseFileReference {
	const operation = 'file upload';
	const file = providerRecord(value, operation);
	if (file.purpose !== undefined && file.purpose !== null && file.purpose !== 'parse') {
		throw new LlamaParseClientError({ message: 'LlamaParse file upload returned an invalid purpose', operation });
	}
	return {
		id: providerIdentifier(file.id, operation, 'file id'),
		name: providerString(file.name, operation, 'file name'),
		projectId: providerIdentifier(file.project_id, operation, 'project id'),
		purpose: 'parse',
	};
}

function parseJobReference(value: unknown, operation: string): LlamaParseJobReference {
	const job = providerRecord(value, operation);
	const status = providerString(job.status, operation, 'job status');
	if (status !== 'PENDING' && status !== 'RUNNING' && status !== 'COMPLETED' && status !== 'FAILED' && status !== 'CANCELLED') {
		throw new LlamaParseClientError({ message: `LlamaParse ${operation} returned an invalid job status`, operation });
	}
	return {
		id: providerIdentifier(job.id, operation, 'job id'),
		projectId: providerIdentifier(job.project_id, operation, 'project id'),
		status,
		tier: job.tier === undefined || job.tier === null ? null : providerString(job.tier, operation, 'job tier'),
	};
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The response is already unusable; cleanup failure must not mask the
		// bounded provider error raised by the caller.
	}
}

async function boundedJson(response: Response, operation: string, maximumBytes: number): Promise<unknown> {
	const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
	if (!contentType.includes('application/json')) {
		await cancelResponseBody(response);
		throw new LlamaParseClientError({ message: `LlamaParse ${operation} returned a non-JSON response`, operation });
	}
	const contentLength = response.headers.get('content-length');
	if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
		await cancelResponseBody(response);
		throw new LlamaParseClientError({ message: `LlamaParse ${operation} response exceeded ${maximumBytes} bytes`, operation });
	}
	if (!response.body) throw new LlamaParseClientError({ message: `LlamaParse ${operation} returned an empty response`, operation });

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	const parts: string[] = [];
	let receivedBytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			receivedBytes += chunk.value.byteLength;
			if (receivedBytes > maximumBytes) {
				await reader.cancel();
				throw new LlamaParseClientError({ message: `LlamaParse ${operation} response exceeded ${maximumBytes} bytes`, operation });
			}
			parts.push(decoder.decode(chunk.value, { stream: true }));
		}
		parts.push(decoder.decode());
		return JSON.parse(parts.join('')) as unknown;
	} catch (error) {
		if (error instanceof LlamaParseClientError) throw error;
		try {
			await reader.cancel();
		} catch {
			// Preserve the bounded parse error below.
		}
		throw new LlamaParseClientError({ message: `LlamaParse ${operation} returned invalid JSON`, operation });
	} finally {
		reader.releaseLock();
	}
}

export function createLlamaParseClient(options: LlamaParseClientOptions): LlamaParseClient {
	const apiKey = safeToken(options.apiKey, 'LlamaParse API key');
	const projectId = options.projectId === undefined ? null : safeIdentifier(options.projectId, 'LlamaParse project id');
	const organizationId = options.organizationId === undefined ? null : safeIdentifier(options.organizationId, 'LlamaParse organization id');
	const fetcher = options.fetcher ?? fetch;

	const requestUrl = (path: string, expand: readonly string[] = []) => {
		const url = new URL(path, LLAMACLOUD_API_ORIGIN);
		if (projectId) url.searchParams.set('project_id', projectId);
		if (organizationId) url.searchParams.set('organization_id', organizationId);
		if (expand.length > 0) url.searchParams.set('expand', expand.join(','));
		return url;
	};

	const request = async (
		operation: string,
		path: string,
		init: RequestInit,
		timeoutMs: number,
		retrySafety: RetrySafety,
		expand: readonly string[] = [],
	): Promise<Response> => {
		const headers = new Headers(init.headers);
		headers.set('accept', 'application/json');
		headers.set('authorization', `Bearer ${apiKey}`);
		let response: Response;
		try {
			response = await fetcher(requestUrl(path, expand), { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
		} catch {
			throw new LlamaParseClientError({
				message: `LlamaParse ${operation} transport failed`,
				operation,
				retryable: retrySafety === 'safe',
			});
		}
		if (!response.ok) {
			const status = response.status;
			const error = new LlamaParseClientError({
				message: `LlamaParse ${operation} failed with HTTP ${status}`,
				operation,
				status,
				retryable: retrySafety === 'safe' && transientHttpStatus(status),
				requestId: responseRequestId(response),
				retryAfterSeconds: retryAfterSeconds(response),
			});
			await cancelResponseBody(response);
			throw error;
		}
		return response;
	};

	const jsonRequest = async (
		operation: string,
		path: string,
		init: RequestInit,
		timeoutMs: number,
		maximumBytes: number,
		retrySafety: RetrySafety,
		expand: readonly string[] = [],
	) => boundedJson(await request(operation, path, init, timeoutMs, retrySafety, expand), operation, maximumBytes);

	return {
		async uploadPdf(pdf) {
			if (pdf.size < 1 || pdf.size > MAX_PDF_UPLOAD_BYTES) {
				throw new TypeError(`LlamaParse PDF must contain between 1 and ${MAX_PDF_UPLOAD_BYTES} bytes`);
			}
			const body = new FormData();
			body.set('purpose', 'parse');
			body.set('file', pdf.type === 'application/pdf' ? pdf : pdf.slice(0, pdf.size, 'application/pdf'), 'document.pdf');
			return parseFileReference(
				await jsonRequest(
					'file upload',
					'/api/v1/beta/files',
					{ method: 'POST', body },
					UPLOAD_TIMEOUT_MS,
					MAX_METADATA_RESPONSE_BYTES,
					'reconcile-required',
				),
			);
		},

		async createParse(fileId, configuration) {
			const id = safeIdentifier(fileId, 'LlamaParse file id');
			const body = JSON.stringify({
				file_id: id,
				tier: configuration.tier,
				version: configuration.version,
				client_name: configuration.client_name,
				page_ranges: configuration.page_ranges,
				output_options: configuration.output_options,
			});
			return parseJobReference(
				await jsonRequest(
					'parse create',
					'/api/v2/parse',
					{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
					METADATA_TIMEOUT_MS,
					MAX_METADATA_RESPONSE_BYTES,
					'reconcile-required',
				),
				'parse create',
			);
		},

		async getParseJob(jobId) {
			const id = encodeURIComponent(safeIdentifier(jobId, 'LlamaParse job id'));
			return parseJobReference(
				await jsonRequest('job status', `/api/v2/parse/${id}`, { method: 'GET' }, METADATA_TIMEOUT_MS, MAX_METADATA_RESPONSE_BYTES, 'safe'),
				'job status',
			);
		},

		async getParseResult(jobId) {
			const id = encodeURIComponent(safeIdentifier(jobId, 'LlamaParse job id'));
			return jsonRequest(
				'parse result',
				`/api/v2/parse/${id}`,
				{ method: 'GET' },
				RESULT_TIMEOUT_MS,
				MAX_PARSE_RESULT_BYTES,
				'safe',
				LLAMAPARSE_V2_RESULT_EXPAND,
			);
		},

		async cancelParse(jobId) {
			const id = encodeURIComponent(safeIdentifier(jobId, 'LlamaParse job id'));
			return parseJobReference(
				await jsonRequest(
					'job cancel',
					`/api/v2/parse/${id}/cancel`,
					{ method: 'POST' },
					METADATA_TIMEOUT_MS,
					MAX_METADATA_RESPONSE_BYTES,
					'safe',
				),
				'job cancel',
			);
		},

		async deleteFile(fileId) {
			const id = encodeURIComponent(safeIdentifier(fileId, 'LlamaParse file id'));
			let response: Response;
			try {
				response = await request('file delete', `/api/v1/beta/files/${id}`, { method: 'DELETE' }, METADATA_TIMEOUT_MS, 'safe');
			} catch (error) {
				if (error instanceof LlamaParseClientError && error.status === 404) return;
				throw error;
			}
			if (response.status !== 204) {
				await cancelResponseBody(response);
				throw new LlamaParseClientError({ message: 'LlamaParse file delete returned an invalid success status', operation: 'file delete' });
			}
			await cancelResponseBody(response);
		},
	};
}
