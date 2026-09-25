// Pure Resource image selection and Hosted Images URL mapping; Cloudflare I/O lives in image-rehosting.ts.
import type { ResourceCreator, ResourceKindMetadata } from './resource.ts';

const HOSTED_RESOURCE_IMAGE_PATTERN = /^https:\/\/imagedelivery\.net\/[a-zA-Z0-9_-]+\/resource-[a-f0-9]{64}\/public$/;
const PREVIEW_IMAGE_TARGET_WIDTH = 1200;
const WORDPRESS_UPLOAD_PATH = /\/wp-content\/uploads\//i;

type ResourceImageFields = Readonly<{
	creators: readonly ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
	ogImageUrl: string | null;
}>;

export function hostedResourceImageUrl(value: string | null | undefined): string | null {
	const url = value?.trim();
	return url && HOSTED_RESOURCE_IMAGE_PATTERN.test(url) ? url : null;
}

export type HostedResourceImage = Readonly<{
	deliveryUrl: string;
	height: number | null;
	sourceUrl: string;
	width: number | null;
}>;

export function normalizedExternalMediaUrl(rawUrl: string | null | undefined, baseUrl?: string): string | null {
	const url = rawUrl?.trim() ? URL.parse(rawUrl, baseUrl) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
	url.protocol = 'https:';
	return url.toString();
}

function positiveInteger(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizedResourceImageUrl(rawUrl: string | null | undefined, baseUrl?: string): string | null {
	const normalized = normalizedExternalMediaUrl(rawUrl, baseUrl);
	if (!normalized) return null;

	const url = new URL(normalized);
	if (!WORDPRESS_UPLOAD_PATH.test(url.pathname)) return normalized;
	const width = positiveInteger(url.searchParams.get('w'));
	const resizeWidth = positiveInteger(url.searchParams.get('resize')?.split(',')[0] ?? null);
	if ((width ?? resizeWidth ?? PREVIEW_IMAGE_TARGET_WIDTH) >= PREVIEW_IMAGE_TARGET_WIDTH) return normalized;

	url.searchParams.set('w', String(PREVIEW_IMAGE_TARGET_WIDTH));
	for (const parameter of ['crop', 'h', 'height', 'resize']) url.searchParams.delete(parameter);
	return url.toString();
}

export function resourceImageSourceUrls(resource: ResourceImageFields): string[] {
	const metadata = resource.kindMetadata && 'attachments' in resource.kindMetadata ? resource.kindMetadata : null;
	const attachments = metadata?.attachments.map((item) => item.url) ?? [];
	const normalized = new Set<string>();
	for (const candidate of [
		attachments[0],
		resource.ogImageUrl,
		...attachments.slice(1),
		...resource.creators.map((creator) => creator.avatarUrl),
	]) {
		if (candidate === null || candidate === undefined) continue;
		const url = normalizedResourceImageUrl(candidate);
		if (!url) throw new TypeError('Resource image source URL is invalid');
		normalized.add(url);
	}
	return [...normalized];
}

function hostedImageMap(images: readonly HostedResourceImage[]): ReadonlyMap<string, HostedResourceImage> {
	const result = new Map<string, HostedResourceImage>();
	for (const image of images) {
		const sourceUrl = normalizedResourceImageUrl(image.sourceUrl);
		const deliveryUrl = hostedResourceImageUrl(image.deliveryUrl);
		const hasDimensions = image.width !== null || image.height !== null;
		if (
			!sourceUrl ||
			sourceUrl !== image.sourceUrl ||
			!deliveryUrl ||
			deliveryUrl !== image.deliveryUrl ||
			(hasDimensions &&
				(!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || (image.width ?? 0) <= 0 || (image.height ?? 0) <= 0))
		) {
			throw new TypeError('Hosted Resource image is invalid');
		}
		if (result.has(sourceUrl)) throw new TypeError('Hosted Resource images contain duplicate sources');
		result.set(sourceUrl, image);
	}
	return result;
}

export function hostedResourceImageFields(
	resource: ResourceImageFields,
	images: readonly HostedResourceImage[],
): {
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata | null;
	ogImageHeight: number | null;
	ogImageUrl: string | null;
	ogImageWidth: number | null;
} {
	const imageMap = hostedImageMap(images);
	const consumedSources = new Set<string>();
	const mapHostedImage = (rawUrl: string): HostedResourceImage => {
		const sourceUrl = normalizedResourceImageUrl(rawUrl);
		if (!sourceUrl) throw new TypeError('Resource image source URL is invalid');
		const image = imageMap.get(sourceUrl);
		if (!image) throw new TypeError('Hosted Resource images do not cover every source');
		consumedSources.add(sourceUrl);
		return image;
	};
	const withHostedAvatar = ({ avatarUrl, ...creator }: ResourceCreator): ResourceCreator =>
		avatarUrl === undefined ? creator : { ...creator, avatarUrl: mapHostedImage(avatarUrl).deliveryUrl };
	const metadata = resource.kindMetadata;
	const kindMetadata =
		metadata && 'attachments' in metadata
			? {
					...metadata,
					attachments: metadata.attachments.map((attachment) => ({ ...attachment, url: mapHostedImage(attachment.url).deliveryUrl })),
				}
			: metadata;
	const ogImage = resource.ogImageUrl === null ? null : mapHostedImage(resource.ogImageUrl);
	const result = {
		creators: resource.creators.map(withHostedAvatar),
		kindMetadata,
		ogImageHeight: ogImage?.height ?? null,
		ogImageUrl: ogImage?.deliveryUrl ?? null,
		ogImageWidth: ogImage?.width ?? null,
	};
	if (consumedSources.size !== imageMap.size) throw new TypeError('Hosted Resource images do not cover every source');
	return result;
}
