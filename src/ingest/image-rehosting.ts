// Shared media rehosting for every Resource platform; this is not the image Resource kind adapter.
import type { WorkflowStep } from 'cloudflare:workers';
import { sha256Hex } from '../shared/hash';
import {
	type HostedResourceImage,
	hostedResourceImageUrl,
	normalizedExternalMediaUrl,
	normalizedResourceImageUrl,
} from '../shared/image-mapping';

const REHOST_TIMEOUT_MS = 8_000;
const MAX_SOURCE_REDIRECTS = 3;
const SOURCE_USER_AGENT = 'Newsence-Media-Rehost/1.0 (+https://newsence.app)';

function failure(code: string, detail?: string): Error {
	return new Error(detail ? `${code}: ${detail}` : code);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
	if (body) await body.cancel().catch(() => undefined);
}

async function redirectTarget(response: Response, currentUrl: string, redirects: number): Promise<string | null> {
	if (![301, 302, 303, 307, 308].includes(response.status)) return null;
	const location = response.headers.get('location');
	await cancelBody(response.body);
	if (redirects >= MAX_SOURCE_REDIRECTS) throw failure('redirect_limit');
	if (!location) throw failure('unsafe_redirect', 'missing Location header');
	const nextUrl = normalizedExternalMediaUrl(location, currentUrl);
	if (!nextUrl) throw failure('unsafe_redirect', 'invalid Location header');
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
			response = await fetch(currentUrl, {
				headers: { Accept: 'image/*', 'User-Agent': SOURCE_USER_AGENT },
				redirect: 'manual',
				signal,
			});
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

async function rehostResourceImage(images: ImagesBinding, sourceUrl: string): Promise<HostedResourceImage> {
	if (normalizedResourceImageUrl(sourceUrl) !== sourceUrl) throw new TypeError('Resource image source URL is invalid');
	const alreadyHosted = hostedResourceImageUrl(sourceUrl);
	if (alreadyHosted) return { deliveryUrl: alreadyHosted, sourceUrl };
	const imageId = `resource-${await sha256Hex(sourceUrl)}`;
	let existing: ImageMetadata | null;
	try {
		existing = await images.hosted.image(imageId).details();
	} catch (error) {
		throw failure('images_read_error', error instanceof Error ? error.message : String(error));
	}
	if (existing) return { deliveryUrl: deliveryUrl(existing), sourceUrl };

	const startedAt = performance.now();
	let image: ImageMetadata;
	try {
		const response = await fetchImageSource(sourceUrl);
		if (!response.body) throw failure('images_write_error', 'missing_body');
		const filename = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 180) || 'resource-image';
		image = await images.hosted
			.upload(response.body, {
				id: imageId,
				filename,
				metadata: { sourceUrl },
				requireSignedURLs: false,
			})
			.catch((error) => {
				throw failure('images_write_error', error instanceof Error ? error.message : String(error));
			});
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
	return { deliveryUrl: deliveryUrl(image), sourceUrl };
}

export async function stageResourceImages(
	env: CoreEnv,
	step: WorkflowStep,
	processingId: string,
	sourceUrls: readonly string[],
): Promise<HostedResourceImage[]> {
	if (sourceUrls.length === 0) return [];
	const images = await step.do(
		'rehost-resource-images-v2',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
		async () => {
			const hosted: HostedResourceImage[] = [];
			for (let offset = 0; offset < sourceUrls.length; offset += 3) {
				hosted.push(...(await Promise.all(sourceUrls.slice(offset, offset + 3).map((url) => rehostResourceImage(env.IMAGES, url)))));
			}
			return hosted;
		},
	);
	console.info({ tag: 'RESOURCE_IMAGE', event: 'eager_rehost_completed', processing_id: processingId, ready: images.length });
	return images;
}
