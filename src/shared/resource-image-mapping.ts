import { hostedResourceImageUrl, type ResourceImageFields, resourcePreviewImageCandidates } from './resource-image-fields.ts';
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
	const value = rawUrl?.trim();
	const sourceUrl = value ? URL.parse(value, baseUrl)?.toString() : null;
	const normalized = validatedExternalMediaUrl(sourceUrl);
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

function uniqueImageUrls(candidates: Array<string | null | undefined>): string[] {
	return [...new Set(candidates.map((url) => normalizedResourceImageUrl(url)).filter((url): url is string => url !== null))];
}

export function resourcePreviewImageSourceUrls(resource: ResourceImageFields): string[] {
	return uniqueImageUrls(resourcePreviewImageCandidates(resource));
}

export function resourceImageSourceUrls(resource: ResourceImageFields): string[] {
	const avatarUrls = resource.creators?.map((creator) => creator.avatarUrl) ?? [];
	const quoteAvatarUrl =
		resource.kindMetadata && 'attachments' in resource.kindMetadata
			? (resource.kindMetadata as PostKindMetadata).quote?.creator.avatarUrl
			: undefined;
	return uniqueImageUrls([...resourcePreviewImageCandidates(resource), ...avatarUrls, quoteAvatarUrl]);
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
	const externalLink = metadata.externalLink
		? (() => {
				const { imageUrl: sourceImageUrl, ...rest } = metadata.externalLink;
				const imageUrl = mappedImageUrl(sourceImageUrl, images);
				return imageUrl ? { ...rest, imageUrl } : rest;
			})()
		: undefined;
	return {
		...metadata,
		attachments,
		...(externalLink ? { externalLink } : {}),
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
	const kindMetadata =
		resource.kindMetadata && 'attachments' in resource.kindMetadata
			? withHostedPostMetadata(resource.kindMetadata as PostKindMetadata, imageMap)
			: (resource.kindMetadata ?? null);
	return {
		creators: resource.creators?.map((creator) => withHostedAvatar(creator, imageMap)) ?? [],
		kindMetadata,
		ogImageUrl: mappedImageUrl(resource.ogImageUrl, imageMap),
	};
}
