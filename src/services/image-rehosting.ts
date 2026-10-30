import { hash } from 'node:crypto';
// Shared media rehosting for every Resource platform; this is not the image Resource kind adapter.
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Image, Nodes } from 'mdast';
import pLimit from 'p-limit';
import type { HostedResourceImage, ResourceImageSources } from '../contracts/image-mapping';
import { parseMarkdown } from '../contracts/markdown';
import { crawlerUserAgent, errorMessage, fetchOk, limitByteStream } from './response';

const REHOST_TIMEOUT_MS = 8_000;
// Hosted Images rejects larger uploads.
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const SOURCE_USER_AGENT = crawlerUserAgent('commonplot-media-rehost');
const NULL_IMAGE_DIMENSIONS = { height: null, width: null } as const;
const MAX_INLINE_IMAGES = 20;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_UPLOAD_CONCURRENCY = 4;
const INLINE_RASTER_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,([a-z0-9+/=]+)$/i;
const HOSTED_RESOURCE_IMAGE_PATTERN = /^https:\/\/imagedelivery\.net\/[a-zA-Z0-9_-]+\/resource-[a-f0-9]{64}\/public$/;

type ImageDimensions = Readonly<Pick<HostedResourceImage, 'height' | 'width'>>;

async function fetchImageSource(sourceUrl: string): Promise<ArrayBuffer> {
	const response = await fetchOk(sourceUrl, {
		label: 'Image fetch',
		timeoutMs: REHOST_TIMEOUT_MS,
		// A gone or refused image stays gone; only a timeout or rate limit is worth another try.
		permanent: (status) => status >= 400 && status < 500 && status !== 408 && status !== 429,
		headers: { Accept: 'image/*', 'User-Agent': SOURCE_USER_AGENT },
	});
	const contentType = response.headers.get('content-type')?.toLowerCase();
	if (contentType && !contentType.startsWith('image/')) {
		await response.body?.cancel();
		throw new NonRetryableError(`not_an_image: ${contentType}`);
	}
	if (!response.body) throw new Error('missing_body');
	const body = limitByteStream(response.body, MAX_SOURCE_IMAGE_BYTES, () => new Error('too_large'));
	return new Response(body).arrayBuffer();
}

function deliveryUrl(image: ImageMetadata): string {
	const hosted = image.variants.find((variant) => variant.endsWith(`/${image.id}/public`))?.trim();
	if (!hosted || !HOSTED_RESOURCE_IMAGE_PATTERN.test(hosted)) throw new Error('images_write_invalid: public delivery variant missing');
	return hosted;
}

async function probeImageDimensions(
	images: ImagesBinding,
	body: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array> | null>,
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
			source_host: new URL(sourceUrl).hostname,
			error: errorMessage(error),
		});
		return NULL_IMAGE_DIMENSIONS;
	}
}

function storedDimension(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Dimensions are kept in the image's metadata at upload. An image stored before that is probed instead:
 * metadata is never updated after upload, since an update can corrupt a Hosted Image's original.
 */
async function hostedDimensions(images: ImagesBinding, image: ImageMetadata, sourceUrl: string): Promise<ImageDimensions> {
	const meta = image.meta ?? {};
	if ('width' in meta && 'height' in meta) return { height: storedDimension(meta.height), width: storedDimension(meta.width) };
	return probeImageDimensions(images, images.hosted.image(image.id).bytes(), sourceUrl);
}

async function hostedImage(images: ImagesBinding, imageId: string): Promise<ImageMetadata | null> {
	try {
		return await images.hosted.image(imageId).details();
	} catch (error) {
		throw new Error(`images_read_error: ${errorMessage(error)}`);
	}
}

type ImageUpload = Readonly<{ bytes: ArrayBuffer; filename: string; metadata?: Record<string, unknown> }>;

/** The image stored under `imageId`, uploaded from `load` only when it is missing. */
async function storedImage(images: ImagesBinding, imageId: string, load: () => Promise<ImageUpload>): Promise<ImageMetadata> {
	const existing = await hostedImage(images, imageId);
	if (existing) return existing;
	const startedAt = performance.now();
	const { bytes, filename, metadata } = await load();
	try {
		const image = await images.hosted.upload(bytes, { id: imageId, filename, metadata, requireSignedURLs: false });
		console.info({
			tag: 'RESOURCE_IMAGE',
			event: 'original_ready',
			duration_ms: Math.round(performance.now() - startedAt),
			image_id: imageId,
		});
		return image;
	} catch (error) {
		// Another Workflow may have stored the same image first.
		const raced = await hostedImage(images, imageId).catch(() => null);
		if (raced) return raced;
		throw new Error(`images_write_error: ${errorMessage(error)}`);
	}
}

/** One stored copy per source URL (already normalized by `resourceImageSources`), so acquiring a Resource again reuses its images. */
async function rehostResourceImage(images: ImagesBinding, sourceUrl: string): Promise<HostedResourceImage> {
	const image = await storedImage(images, `resource-${hash('sha256', sourceUrl, 'hex')}`, async () => {
		const bytes = await fetchImageSource(sourceUrl);
		const dimensions = await probeImageDimensions(images, new Blob([bytes]).stream(), sourceUrl);
		const filename = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 180) || 'resource-image';
		return { bytes, filename, metadata: { sourceUrl, ...dimensions } };
	});
	return { deliveryUrl: deliveryUrl(image), sourceUrl, ...(await hostedDimensions(images, image, sourceUrl)) };
}

function markdownImages(node: Nodes, found: Image[] = []): Image[] {
	if (node.type === 'image') found.push(node);
	if ('children' in node) for (const child of node.children) markdownImages(child, found);
	return found;
}

/**
 * Pages can embed images as `data:` URIs, which have no source to link. Hosted Images keeps
 * the first bounded set of raster images; the rest are dropped instead of stored as Markdown.
 */
export async function rehostInlineImages(images: ImagesBinding, markdown: string): Promise<string> {
	// Most pages embed none, and parsing a long page only to find that is the slow part.
	if (!markdown.includes('data:image/')) return markdown;
	const inline = markdownImages(parseMarkdown(markdown)).filter((image) => image.url.startsWith('data:'));
	if (!inline.length) return markdown;
	const kept = [
		...new Set(
			inline.flatMap((image) => {
				const base64 = INLINE_RASTER_IMAGE.exec(image.url)?.[1];
				return base64 && Buffer.byteLength(base64, 'base64') <= MAX_INLINE_IMAGE_BYTES ? [image.url] : [];
			}),
		),
	].slice(0, MAX_INLINE_IMAGES);
	const limit = pLimit(IMAGE_UPLOAD_CONCURRENCY);
	const uploads = await Promise.all(
		kept.map((dataUrl) =>
			limit(async () => {
				const bytes = new Uint8Array(Buffer.from(INLINE_RASTER_IMAGE.exec(dataUrl)![1]!, 'base64'));
				// Content-addressed, so the same embedded image is stored once however often it is acquired.
				// An image Images cannot read or store is dropped alone; the page still reads.
				const url = await storedImage(images, `resource-${hash('sha256', bytes, 'hex')}`, async () => ({
					bytes: bytes.buffer,
					filename: 'inline-image',
				}))
					.then(deliveryUrl)
					.catch((error: unknown) => {
						console.warn({
							tag: 'RESOURCE_IMAGE',
							event: 'inline_image_failed',
							error: errorMessage(error),
						});
						return null;
					});
				return url ? [[dataUrl, url] as const] : [];
			}),
		),
	);
	const hosted = new Map(uploads.flat());
	let content = markdown;
	let dropped = 0;
	// Replace from the end so earlier offsets stay valid.
	for (const image of [...inline].reverse()) {
		const start = image.position?.start.offset;
		const end = image.position?.end.offset;
		if (start === undefined || end === undefined) continue;
		const url = hosted.get(image.url);
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
): Promise<HostedResourceImage[]> {
	if (sourceUrls.length === 0) return [];
	// Step names follow source order, so replay stays deterministic however the pool interleaves.
	const images = await pLimit(3).map(sourceUrls, (url, index) =>
		step
			.do(
				`rehost-resource-image-v4-${index}`,
				// An optional image (a preview or avatar) is tried once; nothing waits on it.
				{ retries: { limit: optional.has(url) ? 0 : 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
				() => rehostResourceImage(env.IMAGES, url),
			)
			.catch((error: unknown) => {
				if (!optional.has(url)) throw error;
				console.warn({
					tag: 'RESOURCE_IMAGE',
					event: 'optional_image_skipped',
					processing_id: processingId,
					source_host: new URL(url).hostname,
					error: errorMessage(error),
				});
				return null;
			}),
	);
	const ready = images.filter((image) => image !== null);
	console.info({ tag: 'RESOURCE_IMAGE', event: 'eager_rehost_completed', processing_id: processingId, ready: ready.length });
	return ready;
}
