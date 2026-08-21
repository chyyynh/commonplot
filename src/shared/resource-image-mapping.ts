import {
	hostedResourceImageUrl,
	type ResourceImageFields,
	resourceImageCandidates,
	resourcePostMetadata,
} from './resource-image-fields.ts';
import type { PostKindMetadata, ResourceCreator, ResourceKindMetadata } from './resource-metadata.ts';
import { validatedExternalMediaUrl } from './url.ts';

const PREVIEW_IMAGE_TARGET_WIDTH = 1200;
const WORDPRESS_UPLOAD_PATH = /\/wp-content\/uploads\//i;

export type HostedResourceImage = Readonly<{
	deliveryUrl: string;
	sourceUrl: string;
}>;

function positiveInteger(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizedResourceImageUrl(rawUrl: string | null | undefined, baseUrl?: string): string | null {
	const normalized = validatedExternalMediaUrl(rawUrl, baseUrl);
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
	const normalized: string[] = [];
	for (const candidate of resourceImageCandidates(resource)) {
		const url = normalizedResourceImageUrl(candidate);
		if (!url) throw new TypeError('Resource image source URL is invalid');
		normalized.push(url);
	}
	return [...new Set(normalized)];
}

function hostedImageMap(images: readonly HostedResourceImage[]): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	for (const image of images) {
		const sourceUrl = normalizedResourceImageUrl(image.sourceUrl);
		const deliveryUrl = hostedResourceImageUrl(image.deliveryUrl);
		if (!sourceUrl || sourceUrl !== image.sourceUrl || !deliveryUrl || deliveryUrl !== image.deliveryUrl) {
			throw new TypeError('Hosted Resource image is invalid');
		}
		if (result.has(sourceUrl)) throw new TypeError('Hosted Resource images contain duplicate sources');
		result.set(sourceUrl, deliveryUrl);
	}
	return result;
}

function mappedImageUrl(rawUrl: string | null | undefined, images: ReadonlyMap<string, string>): string | null {
	const sourceUrl = normalizedResourceImageUrl(rawUrl);
	return sourceUrl ? (images.get(sourceUrl) ?? null) : null;
}

function withHostedAvatar(creator: ResourceCreator, images: ReadonlyMap<string, string>): ResourceCreator {
	const { avatarUrl: sourceAvatarUrl, ...rest } = creator;
	const avatarUrl = mappedImageUrl(sourceAvatarUrl, images);
	return avatarUrl ? { ...rest, avatarUrl } : rest;
}

function withHostedPostMetadata(metadata: PostKindMetadata, images: ReadonlyMap<string, string>): PostKindMetadata {
	const attachments = metadata.attachments.flatMap((attachment) => {
		const url = mappedImageUrl(attachment.url, images);
		return url ? [{ ...attachment, url }] : [];
	});
	return {
		...metadata,
		attachments,
		...(metadata.quote
			? {
					quote: {
						...metadata.quote,
						creator: withHostedAvatar(metadata.quote.creator, images),
					},
				}
			: {}),
	};
}

export function hostedResourceImageFields(
	resource: ResourceImageFields,
	images: readonly HostedResourceImage[],
): { creators: ResourceCreator[]; kindMetadata: ResourceKindMetadata | null; ogImageUrl: string | null } {
	const imageMap = hostedImageMap(images);
	const sourceUrls = resourceImageSourceUrls(resource);
	if (imageMap.size !== sourceUrls.length || sourceUrls.some((sourceUrl) => !imageMap.has(sourceUrl))) {
		throw new TypeError('Hosted Resource images do not cover every source');
	}
	const postMetadata = resourcePostMetadata(resource);
	const kindMetadata = postMetadata ? withHostedPostMetadata(postMetadata, imageMap) : (resource.kindMetadata ?? null);
	return {
		creators: resource.creators?.map((creator) => withHostedAvatar(creator, imageMap)) ?? [],
		kindMetadata,
		ogImageUrl: mappedImageUrl(resource.ogImageUrl, imageMap),
	};
}
