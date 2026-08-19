import { fetchWithTimeout, readBytesWithLimit } from '@core-shared/http';
import {
	normalizedResourceImageUrl,
	type ResourceImageRef,
	resourceImageId,
	validatedExternalMediaUrl,
} from '@core-shared/resource-images';

const MAX_HOSTED_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REHOST_TIMEOUT_MS = 8_000;
const MAX_SOURCE_REDIRECTS = 3;
const SOURCE_USER_AGENT = 'Newsence-Media-Rehost/1.0 (+https://newsence.app)';

type ResourceImageFailureCode =
	| 'empty_body'
	| 'fetch_error'
	| 'images_read_error'
	| 'images_transform_error'
	| 'images_write_error'
	| 'images_write_invalid'
	| 'invalid_content_type'
	| 'missing_body'
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
	if (!contentType.startsWith('image/')) {
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

function deliveryUrl(image: ImageMetadata, sourceUrl: string): string {
	const value = image.variants.find((variant) => variant.endsWith(`/${image.id}/public`));
	if (!value) throw failure('images_write_invalid', sourceUrl, 'public delivery variant missing');
	return value;
}

function imageRef(image: ImageMetadata, sourceUrl: string): ResourceImageRef {
	return { deliveryUrl: deliveryUrl(image, sourceUrl), imageId: image.id, sourceUrl };
}

function imageFilename(sourceUrl: string): string {
	const filename = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 180);
	return filename || 'resource-image';
}

async function transformLargeImage(images: ImagesBinding, response: Response, sourceUrl: string): Promise<ReadableStream<Uint8Array>> {
	if (!response.body) throw failure('missing_body', sourceUrl);
	try {
		return (
			await images
				.input(response.body)
				.transform({ fit: 'scale-down', height: 4096, width: 4096 })
				.output({ anim: true, format: 'image/webp', quality: 82 })
		).image();
	} catch (error) {
		throw failure('images_transform_error', sourceUrl, error instanceof Error ? error.message : String(error));
	}
}

async function uploadImage(images: ImagesBinding, imageId: string, sourceUrl: string, response: Response): Promise<ImageMetadata> {
	const declaredLength = contentLength(response);
	if (declaredLength !== null && declaredLength > MAX_IMAGE_BYTES) {
		await cancelBody(response.body);
		throw failure('source_too_large', sourceUrl);
	}

	try {
		if (declaredLength !== null && declaredLength > 0) {
			const upload = declaredLength <= MAX_HOSTED_UPLOAD_BYTES ? response.body : await transformLargeImage(images, response, sourceUrl);
			if (!upload) throw failure('missing_body', sourceUrl);
			return await images.hosted.upload(upload, {
				id: imageId,
				filename: imageFilename(sourceUrl),
				metadata: { sourceUrl },
				requireSignedURLs: false,
			});
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
		const upload =
			bytes.byteLength <= MAX_HOSTED_UPLOAD_BYTES
				? (bytes.slice().buffer as ArrayBuffer)
				: await transformLargeImage(images, new Response(bytes), sourceUrl);
		return await images.hosted.upload(upload, {
			id: imageId,
			filename: imageFilename(sourceUrl),
			metadata: { sourceUrl },
			requireSignedURLs: false,
		});
	} catch (error) {
		if (error instanceof ResourceImageRehostError) throw error;
		throw failure('images_write_error', sourceUrl, error instanceof Error ? error.message : String(error));
	}
}

export async function rehostResourceImage(images: ImagesBinding, sourceUrl: string): Promise<ResourceImageRef> {
	if (normalizedResourceImageUrl(sourceUrl) !== sourceUrl) throw new TypeError('Resource image source URL is invalid');
	const imageId = await resourceImageId(sourceUrl);
	let existing: ImageMetadata | null;
	try {
		existing = await images.hosted.image(imageId).details();
	} catch (error) {
		throw failure('images_read_error', sourceUrl, error instanceof Error ? error.message : String(error));
	}
	if (existing) return imageRef(existing, sourceUrl);

	const startedAt = performance.now();
	let image: ImageMetadata;
	try {
		image = await uploadImage(images, imageId, sourceUrl, await fetchImageSource(sourceUrl));
	} catch (error) {
		const raced = await images.hosted
			.image(imageId)
			.details()
			.catch(() => null);
		if (!raced) throw error;
		image = raced;
	}
	console.info({
		tag: 'RESOURCE_IMAGE',
		event: 'original_ready',
		duration_ms: Math.round(performance.now() - startedAt),
		image_id: image.id,
		source_host: new URL(sourceUrl).hostname,
	});
	return imageRef(image, sourceUrl);
}
