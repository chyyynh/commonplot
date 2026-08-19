import { fetchWithTimeout, readBytesWithLimit } from '@core-shared/http';
import {
	isResourceImageRevision,
	RESOURCE_IMAGE_CACHE_CONTROL,
	type ResourceImagePlan,
	resourceImageStorageKey,
	validatedExternalMediaUrl,
} from '@core-shared/resource-images';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const REHOST_TIMEOUT_MS = 8_000;
const MAX_SOURCE_REDIRECTS = 3;
const REHOST_CONCURRENCY = 3;
const SOURCE_USER_AGENT = 'Newsence-Media-Rehost/1.0 (+https://newsence.app)';

type ResourceImageFailureCode =
	| 'empty_body'
	| 'fetch_error'
	| 'invalid_content_type'
	| 'missing_body'
	| 'r2_read_error'
	| 'r2_write_error'
	| 'r2_write_invalid'
	| 'redirect_limit'
	| 'source_too_large'
	| 'unsafe_redirect'
	| 'upstream_status';

class ResourceImageRehostError extends Error {
	constructor(
		readonly code: ResourceImageFailureCode,
		readonly sourceHost: string,
		message: string,
	) {
		super(message);
		this.name = 'ResourceImageRehostError';
	}
}

function failure(code: ResourceImageFailureCode, sourceUrl: string, detail?: string): ResourceImageRehostError {
	const sourceHost = new URL(sourceUrl).hostname;
	return new ResourceImageRehostError(code, sourceHost, detail ? `${code}: ${detail}` : code);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
	if (body) await body.cancel().catch(() => undefined);
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function redirectTarget(response: Response, currentUrl: string, sourceUrl: string, redirects: number): Promise<string | null> {
	if (!isRedirectStatus(response.status)) return null;
	const location = response.headers.get('location');
	await cancelBody(response.body);
	if (redirects >= MAX_SOURCE_REDIRECTS) throw failure('redirect_limit', sourceUrl);
	if (!location) throw failure('unsafe_redirect', sourceUrl, 'missing Location header');
	let resolved: string;
	try {
		resolved = new URL(location, currentUrl).toString();
	} catch {
		throw failure('unsafe_redirect', sourceUrl, 'invalid Location header');
	}
	const nextUrl = validatedExternalMediaUrl(resolved);
	if (!nextUrl) throw failure('unsafe_redirect', sourceUrl);
	return nextUrl;
}

async function assertImageResponse(response: Response, sourceUrl: string): Promise<void> {
	if (!response.ok) {
		await cancelBody(response.body);
		throw failure('upstream_status', sourceUrl, `HTTP ${response.status}`);
	}
	if (!response.body) throw failure('missing_body', sourceUrl);
	const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
	if (!contentType.startsWith('image/') || contentType.startsWith('image/svg')) {
		await cancelBody(response.body);
		throw failure('invalid_content_type', sourceUrl, contentType || 'missing content-type');
	}
}

async function fetchImageSource(sourceUrl: string): Promise<Response> {
	let currentUrl = sourceUrl;
	const signal = AbortSignal.timeout(REHOST_TIMEOUT_MS);

	for (let redirects = 0; ; redirects += 1) {
		let response: Response;
		try {
			response = await fetchWithTimeout(
				currentUrl,
				{
					headers: { Accept: 'image/*', 'User-Agent': SOURCE_USER_AGENT },
					redirect: 'manual',
					signal,
				},
				REHOST_TIMEOUT_MS,
			);
		} catch (error) {
			throw failure('fetch_error', sourceUrl, error instanceof Error ? error.message : String(error));
		}

		const nextUrl = await redirectTarget(response, currentUrl, sourceUrl, redirects);
		if (nextUrl) {
			currentUrl = nextUrl;
			continue;
		}
		await assertImageResponse(response, sourceUrl);
		return response;
	}
}

function contentLength(response: Response): number | null {
	const raw = response.headers.get('content-length')?.trim();
	if (!raw || !/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

function putOptions(contentType: string): R2PutOptions {
	return {
		httpMetadata: {
			cacheControl: RESOURCE_IMAGE_CACHE_CONTROL,
			contentType,
		},
	};
}

async function storeImage(bucket: R2Bucket, key: string, sourceUrl: string, response: Response): Promise<number> {
	const declaredLength = contentLength(response);
	if (declaredLength !== null && declaredLength > MAX_IMAGE_BYTES) {
		await cancelBody(response.body);
		throw failure('source_too_large', sourceUrl);
	}
	const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream';

	try {
		if (declaredLength !== null && declaredLength > 0 && response.body) {
			const { readable, writable } = new FixedLengthStream(declaredLength);
			const [object] = await Promise.all([bucket.put(key, readable, putOptions(contentType)), response.body.pipeTo(writable)]);
			if (object.size !== declaredLength || object.size <= 0) throw failure('r2_write_invalid', sourceUrl);
			return object.size;
		}

		let bytes: Uint8Array;
		try {
			bytes = await readBytesWithLimit(response, MAX_IMAGE_BYTES);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (/too large|exceeded/i.test(detail)) throw failure('source_too_large', sourceUrl, detail);
			throw error;
		}
		if (bytes.byteLength === 0) throw failure('empty_body', sourceUrl);
		const object = await bucket.put(key, bytes, putOptions(contentType));
		if (object.size !== bytes.byteLength || object.size <= 0) throw failure('r2_write_invalid', sourceUrl);
		return object.size;
	} catch (error) {
		if (error instanceof ResourceImageRehostError) throw error;
		throw failure('r2_write_error', sourceUrl, error instanceof Error ? error.message : String(error));
	}
}

async function ensureResourceImage(bucket: R2Bucket, sourceUrl: string): Promise<void> {
	const key = await resourceImageStorageKey(sourceUrl);
	let existing: R2Object | null;
	try {
		existing = await bucket.head(key);
	} catch (error) {
		throw failure('r2_read_error', sourceUrl, error instanceof Error ? error.message : String(error));
	}
	if (existing && existing.size > 0) return;

	const startedAt = performance.now();
	const bytes = await storeImage(bucket, key, sourceUrl, await fetchImageSource(sourceUrl));
	console.info({
		tag: 'RESOURCE_IMAGE',
		event: 'original_ready',
		bytes,
		duration_ms: Math.round(performance.now() - startedAt),
		source_host: new URL(sourceUrl).hostname,
	});
}

export async function rehostResourceImages(bucket: R2Bucket, plan: ResourceImagePlan): Promise<void> {
	if (plan.revision === null) {
		if (plan.urls.length !== 0) throw new Error('Resource image plan has sources without a revision');
		return;
	}
	if (!isResourceImageRevision(plan.revision) || plan.urls.length === 0) throw new Error('Resource image plan is invalid');

	const failures: ResourceImageRehostError[] = [];
	for (let offset = 0; offset < plan.urls.length; offset += REHOST_CONCURRENCY) {
		const results = await Promise.allSettled(
			plan.urls.slice(offset, offset + REHOST_CONCURRENCY).map((url) => ensureResourceImage(bucket, url)),
		);
		for (const result of results) {
			if (result.status === 'fulfilled') continue;
			failures.push(
				result.reason instanceof ResourceImageRehostError
					? result.reason
					: new ResourceImageRehostError(
							'fetch_error',
							'unknown',
							result.reason instanceof Error ? result.reason.message : String(result.reason),
						),
			);
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`Failed to rehost ${failures.length} of ${plan.urls.length} resource images (${failures
				.map((error) => `${error.sourceHost}:${error.code}`)
				.join(', ')})`,
		);
	}
}
