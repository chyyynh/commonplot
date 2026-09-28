import { hash } from 'node:crypto';
// Shared media rehosting for every Resource platform; this is not the image Resource kind adapter.
import type { WorkflowStep } from 'cloudflare:workers';
import type { Image, Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import {
	type HostedResourceImage,
	hostedResourceImageUrl,
	type ResourceImageSources,
	normalizedExternalMediaUrl,
	normalizedResourceImageUrl,
} from '../contracts/image-mapping';

const REHOST_TIMEOUT_MS = 8_000;
const MAX_SOURCE_REDIRECTS = 3;
const SOURCE_USER_AGENT = 'Newsence-Media-Rehost/1.0 (+https://newsence.app)';
const NULL_IMAGE_DIMENSIONS = { height: null, width: null } as const;
const MAX_INLINE_IMAGES = 20;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const INLINE_RASTER_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,([a-z0-9+/=]+)$/i;

type ImageDimensions = Readonly<Pick<HostedResourceImage, 'height' | 'width'>>;

async function fetchImageSource(sourceUrl: string): Promise<ReadableStream<Uint8Array>> {
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
			throw new Error(`fetch_error: ${error instanceof Error ? error.message : String(error)}`);
		}

		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get('location');
			await response.body?.cancel().catch(() => undefined);
			if (redirects >= MAX_SOURCE_REDIRECTS) throw new Error('redirect_limit');
			if (!location) throw new Error('unsafe_redirect: missing Location header');
			const nextUrl = normalizedExternalMediaUrl(location, currentUrl);
			if (!nextUrl) throw new Error('unsafe_redirect: invalid Location header');
			currentUrl = nextUrl;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`upstream_status: HTTP ${response.status}`);
		}
		if (!response.body) throw new Error('missing_body');
		return response.body;
	}
}

function deliveryUrl(image: ImageMetadata): string {
	const value = image.variants.find((variant) => variant.endsWith(`/${image.id}/public`));
	const hosted = hostedResourceImageUrl(value);
	if (!hosted?.endsWith(`/${image.id}/public`)) {
		throw new Error('images_write_invalid: public delivery variant missing');
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
		if (!imageId) throw new Error('images_read_error: hosted image ID missing');
		return {
			deliveryUrl: alreadyHosted,
			sourceUrl,
			...(await probeImageDimensions(images, images.hosted.image(imageId).bytes(), imageId, sourceUrl)),
		};
	}
	const imageId = `resource-${hash('sha256', refreshKey ? `${sourceUrl}:${refreshKey}` : sourceUrl, 'hex')}`;
	let existing: ImageMetadata | null;
	try {
		existing = await images.hosted.image(imageId).details();
	} catch (error) {
		throw new Error(`images_read_error: ${error instanceof Error ? error.message : String(error)}`);
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
		const [infoBody, uploadBody] = (await fetchImageSource(sourceUrl)).tee();
		const filename = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 180) || 'resource-image';
		const [info, upload] = await Promise.allSettled([
			probeImageDimensions(images, infoBody, imageId, sourceUrl),
			images.hosted.upload(uploadBody, { id: imageId, filename, metadata: { sourceUrl }, requireSignedURLs: false }),
		]);
		if (info.status === 'rejected') throw info.reason;
		if (upload.status === 'rejected') {
			throw new Error(`images_write_error: ${upload.reason instanceof Error ? upload.reason.message : String(upload.reason)}`);
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

function markdownImages(node: Nodes, found: Image[] = []): Image[] {
	if (node.type === 'image') found.push(node);
	if ('children' in node) for (const child of node.children) markdownImages(child, found);
	return found;
}

/** Content-addressed, so the same embedded image is stored once however often it is acquired. */
async function hostInlineImage(images: ImagesBinding, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const imageId = `resource-${hash('sha256', bytes, 'hex')}`;
	const stored = () => images.hosted.image(imageId).details();
	const existing = await stored();
	if (existing) return deliveryUrl(existing);
	try {
		return deliveryUrl(
			await images.hosted.upload(new Blob([bytes]).stream(), { id: imageId, filename: 'inline-image', requireSignedURLs: false }),
		);
	} catch (error) {
		const raced = await stored().catch(() => null);
		if (!raced) throw new Error(`images_write_error: ${error instanceof Error ? error.message : String(error)}`);
		return deliveryUrl(raced);
	}
}

/**
 * Pages can embed images as `data:` URIs, which have no source to link. Hosted Images keeps
 * the first bounded set of raster images; the rest are dropped instead of stored as Markdown.
 */
export async function rehostInlineImages(images: ImagesBinding, markdown: string): Promise<string> {
	const inline = markdownImages(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })).filter((image) =>
		image.url.startsWith('data:'),
	);
	if (!inline.length) return markdown;
	const hosted = new Map<string, string>();
	let content = markdown;
	let dropped = 0;
	// Replace from the end so earlier offsets stay valid.
	for (const image of [...inline].reverse()) {
		const start = image.position?.start.offset;
		const end = image.position?.end.offset;
		if (start === undefined || end === undefined) continue;
		let url = hosted.get(image.url);
		const base64 = INLINE_RASTER_IMAGE.exec(image.url)?.[1];
		if (!url && base64 && hosted.size < MAX_INLINE_IMAGES) {
			const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
			if (bytes.length <= MAX_INLINE_IMAGE_BYTES) {
				url = await hostInlineImage(images, bytes);
				hosted.set(image.url, url);
			}
		}
		if (!url) dropped += 1;
		const source = content.slice(start, end);
		content = content.slice(0, start) + (url ? source.replace(image.url, url) : '') + content.slice(end);
	}
	console.info({ tag: 'RESOURCE_IMAGE', event: 'inline_images_rehosted', hosted: hosted.size, dropped });
	return content;
}

export async function stageResourceImages(
	env: CoreEnv,
	step: WorkflowStep,
	processingId: string,
	{ urls: sourceUrls, optional }: ResourceImageSources,
	refreshKey?: string,
): Promise<HostedResourceImage[]> {
	if (sourceUrls.length === 0) return [];
	const images: (HostedResourceImage | null)[] = [];
	for (let offset = 0; offset < sourceUrls.length; offset += 3) {
		images.push(
			...(await Promise.all(
				sourceUrls.slice(offset, offset + 3).map((url, index) =>
					step
						.do(
							`rehost-resource-image-v4-${offset + index}`,
							{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
							() => rehostResourceImage(env.IMAGES, url, refreshKey),
						)
						.catch((error: unknown) => {
							if (!optional.has(url)) throw error;
							console.warn({
								tag: 'RESOURCE_IMAGE',
								event: 'optional_image_skipped',
								processing_id: processingId,
								source_host: new URL(url).hostname,
								error: error instanceof Error ? error.message : String(error),
							});
							return null;
						}),
				),
			)),
		);
	}
	const ready = images.filter((image) => image !== null);
	console.info({ tag: 'RESOURCE_IMAGE', event: 'eager_rehost_completed', processing_id: processingId, ready: ready.length });
	return ready;
}
