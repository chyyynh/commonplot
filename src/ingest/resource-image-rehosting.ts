import { fetchWithTimeout } from '@core-shared/http';
import {
	type HostedResourceImage,
	hostedResourceImageUrl,
	normalizedResourceImageUrl,
	resourceImageId,
	validatedExternalMediaUrl,
} from '@core-shared/resource-images';

const REHOST_TIMEOUT_MS = 8_000;
const MAX_SOURCE_REDIRECTS = 3;
const SOURCE_USER_AGENT = 'Newsence-Media-Rehost/1.0 (+https://newsence.app)';

function failure(code: string, detail?: string): Error {
	return new Error(detail ? `${code}: ${detail}` : code);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
	if (body) await body.cancel().catch(() => undefined);
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function redirectTarget(response: Response, currentUrl: string, redirects: number): Promise<string | null> {
	if (!isRedirectStatus(response.status)) return null;
	const location = response.headers.get('location');
	await cancelBody(response.body);
	if (redirects >= MAX_SOURCE_REDIRECTS) throw failure('redirect_limit');
	if (!location) throw failure('unsafe_redirect', 'missing Location header');
	let resolved: string;
	try {
		resolved = new URL(location, currentUrl).toString();
	} catch {
		throw failure('unsafe_redirect', 'invalid Location header');
	}
	const nextUrl = validatedExternalMediaUrl(resolved);
	if (!nextUrl) throw failure('unsafe_redirect');
	return nextUrl;
}

async function assertImageResponse(response: Response): Promise<void> {
	if (!response.ok) {
		await cancelBody(response.body);
		throw failure('upstream_status', `HTTP ${response.status}`);
	}
	if (!response.body) throw failure('missing_body');
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
			throw failure('fetch_error', error instanceof Error ? error.message : String(error));
		}

		const nextUrl = await redirectTarget(response, currentUrl, redirects);
		if (nextUrl) {
			currentUrl = nextUrl;
			continue;
		}
		await assertImageResponse(response);
		return response;
	}
}

function deliveryUrl(image: ImageMetadata): string {
	const value = image.variants.find((variant) => variant.endsWith(`/${image.id}/public`));
	const hosted = hostedResourceImageUrl(value);
	if (!hosted?.endsWith(`/${image.id}/public`)) {
		throw failure('images_write_invalid', 'public delivery variant missing');
	}
	return hosted;
}

function hostedImage(image: ImageMetadata, sourceUrl: string): HostedResourceImage {
	return { deliveryUrl: deliveryUrl(image), sourceUrl };
}

function imageFilename(sourceUrl: string): string {
	const filename = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 180);
	return filename || 'resource-image';
}

async function uploadImage(images: ImagesBinding, imageId: string, sourceUrl: string, response: Response): Promise<ImageMetadata> {
	try {
		if (!response.body) throw failure('missing_body');
		return await images.hosted.upload(response.body, {
			id: imageId,
			filename: imageFilename(sourceUrl),
			metadata: { sourceUrl },
			requireSignedURLs: false,
		});
	} catch (error) {
		throw failure('images_write_error', error instanceof Error ? error.message : String(error));
	}
}

export async function rehostResourceImage(images: ImagesBinding, sourceUrl: string): Promise<HostedResourceImage> {
	if (normalizedResourceImageUrl(sourceUrl) !== sourceUrl) throw new TypeError('Resource image source URL is invalid');
	const alreadyHosted = hostedResourceImageUrl(sourceUrl);
	if (alreadyHosted) return { deliveryUrl: alreadyHosted, sourceUrl };
	const imageId = await resourceImageId(sourceUrl);
	let existing: ImageMetadata | null;
	try {
		existing = await images.hosted.image(imageId).details();
	} catch (error) {
		throw failure('images_read_error', error instanceof Error ? error.message : String(error));
	}
	if (existing) return hostedImage(existing, sourceUrl);

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
	return hostedImage(image, sourceUrl);
}
