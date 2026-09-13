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
const NULL_IMAGE_DIMENSIONS = { height: null, width: null } as const;

type ImageDimensions = Readonly<Pick<HostedResourceImage, 'height' | 'width'>>;

function failure(code: string, detail?: string): Error {
	return new Error(detail ? `${code}: ${detail}` : code);
}

async function redirectTarget(response: Response, currentUrl: string, redirects: number): Promise<string | null> {
	if (![301, 302, 303, 307, 308].includes(response.status)) return null;
	const location = response.headers.get('location');
	await response.body?.cancel().catch(() => undefined);
	if (redirects >= MAX_SOURCE_REDIRECTS) throw failure('redirect_limit');
	if (!location) throw failure('unsafe_redirect', 'missing Location header');
	const nextUrl = normalizedExternalMediaUrl(location, currentUrl);
	if (!nextUrl) throw failure('unsafe_redirect', 'invalid Location header');
	return nextUrl;
}

async function assertImageResponse(response: Response): Promise<void> {
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
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

async function probeImageDimensions(
	images: ImagesBinding,
	body: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array> | null>,
	imageId: string,
	sourceUrl: string,
): Promise<ImageDimensions> {
	try {
		const input = await body;
		if (!input) return NULL_IMAGE_DIMENSIONS;
		const info = await images.info(input);
		if (
			!('width' in info) ||
			!Number.isSafeInteger(info.width) ||
			!Number.isSafeInteger(info.height) ||
			info.width <= 0 ||
			info.height <= 0
		) {
			return NULL_IMAGE_DIMENSIONS;
		}
		return { height: info.height, width: info.width };
	} catch (error) {
		console.warn({
			tag: 'RESOURCE_IMAGE',
			event: 'dimensions_unavailable',
			image_id: imageId,
			source_host: new URL(sourceUrl).hostname,
			error: error instanceof Error ? error.message : String(error),
		});
		return NULL_IMAGE_DIMENSIONS;
	}
}

async function rehostResourceImage(images: ImagesBinding, sourceUrl: string, refreshKey?: string): Promise<HostedResourceImage> {
	if (normalizedResourceImageUrl(sourceUrl) !== sourceUrl) throw new TypeError('Resource image source URL is invalid');
	const alreadyHosted = hostedResourceImageUrl(sourceUrl);
	if (alreadyHosted) {
		const imageId = new URL(alreadyHosted).pathname.split('/').at(-2);
		if (!imageId) throw failure('images_read_error', 'hosted image ID missing');
		return {
			deliveryUrl: alreadyHosted,
			sourceUrl,
			...(await probeImageDimensions(images, images.hosted.image(imageId).bytes(), imageId, sourceUrl)),
		};
	}
	const imageId = `resource-${await sha256Hex(refreshKey ? `${sourceUrl}:${refreshKey}` : sourceUrl)}`;
	let existing: ImageMetadata | null;
	try {
		existing = await images.hosted.image(imageId).details();
	} catch (error) {
		throw failure('images_read_error', error instanceof Error ? error.message : String(error));
	}
	if (existing) {
		return {
			deliveryUrl: deliveryUrl(existing),
			sourceUrl,
			...(await probeImageDimensions(images, images.hosted.image(existing.id).bytes(), existing.id, sourceUrl)),
		};
	}

	const startedAt = performance.now();
	let dimensions: ImageDimensions;
	let image: ImageMetadata;
	try {
		const response = await fetchImageSource(sourceUrl);
		if (!response.body) throw failure('images_write_error', 'missing_body');
		const [infoBody, uploadBody] = response.body.tee();
		const filename = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 180) || 'resource-image';
		const [info, upload] = await Promise.allSettled([
			probeImageDimensions(images, infoBody, imageId, sourceUrl),
			images.hosted.upload(uploadBody, { id: imageId, filename, metadata: { sourceUrl }, requireSignedURLs: false }),
		]);
		if (info.status === 'rejected') throw info.reason;
		if (upload.status === 'rejected') {
			throw failure('images_write_error', upload.reason instanceof Error ? upload.reason.message : String(upload.reason));
		}
		dimensions = info.value;
		image = upload.value;
	} catch (error) {
		const raced = await images.hosted
			.image(imageId)
			.details()
			.catch(() => null);
		if (!raced) throw error;
		image = raced;
		dimensions = await probeImageDimensions(images, images.hosted.image(image.id).bytes(), image.id, sourceUrl);
	}
	console.info({
		tag: 'RESOURCE_IMAGE',
		event: 'original_ready',
		duration_ms: Math.round(performance.now() - startedAt),
		image_id: image.id,
		source_host: new URL(sourceUrl).hostname,
	});
	return { deliveryUrl: deliveryUrl(image), sourceUrl, ...dimensions };
}

export async function stageResourceImages(
	env: CoreEnv,
	step: WorkflowStep,
	processingId: string,
	sourceUrls: readonly string[],
	refreshKey?: string,
): Promise<HostedResourceImage[]> {
	if (sourceUrls.length === 0) return [];
	const images: HostedResourceImage[] = [];
	for (let offset = 0; offset < sourceUrls.length; offset += 3) {
		images.push(
			...(await Promise.all(
				sourceUrls
					.slice(offset, offset + 3)
					.map((url, index) =>
						step.do(
							`rehost-resource-image-v4-${offset + index}`,
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
							() => rehostResourceImage(env.IMAGES, url, refreshKey),
						),
					),
			)),
		);
	}
	console.info({ tag: 'RESOURCE_IMAGE', event: 'eager_rehost_completed', processing_id: processingId, ready: images.length });
	return images;
}
