import { sha256Hex } from './hash.ts';
import type { PostKindMetadata, ResourceCreator, ResourceKindMetadata } from './resource-metadata.ts';
import { normalizePreviewImageUrl } from './url.ts';

export const RESOURCE_IMAGE_ID_PREFIX = 'resource-';

const RESOURCE_IMAGE_ID_PATTERN = /^resource-[a-f0-9]{64}$/;

export type ResourceImageSourceRecord = Readonly<{
	creators?: readonly ResourceCreator[] | null;
	kindMetadata?: ResourceKindMetadata | null;
	ogImageUrl?: string | null;
}>;

export type HostedResourceImage = Readonly<{
	deliveryUrl: string;
	sourceUrl: string;
}>;

export type HostedResourceImageFields = Readonly<{
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata | null;
	ogImageUrl: string | null;
}>;

function isPrivateHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
	if (host.includes(':')) {
		return (
			host === '::' ||
			host === '::1' ||
			host.startsWith('::ffff:') ||
			host.startsWith('fc') ||
			host.startsWith('fd') ||
			/^fe[89ab]/.test(host) ||
			host.startsWith('ff')
		);
	}
	const octets = host.split('.').map(Number);
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	return (
		octets[0] === 0 ||
		octets[0] === 10 ||
		octets[0] === 127 ||
		(octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) ||
		(octets[0] === 169 && octets[1] === 254) ||
		(octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
		(octets[0] === 192 && (octets[1] === 0 || octets[1] === 168)) ||
		(octets[0] === 198 && ((octets[1] ?? 0) === 18 || (octets[1] ?? 0) === 19)) ||
		(octets[0] ?? 0) >= 224
	);
}

/** External media URL safe for a Worker origin fetch. */
export function validatedExternalMediaUrl(rawUrl: string | null | undefined): string | null {
	const value = rawUrl?.trim();
	if (!value) return null;
	const normalized = /^http:\/\//i.test(value) ? value.replace(/^http:/i, 'https:') : value;
	try {
		const url = new URL(normalized);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (url.username || url.password || isPrivateHostname(url.hostname)) return null;
		return url.toString();
	} catch {
		return null;
	}
}

export function normalizedResourceImageUrl(rawUrl: string | null | undefined): string | null {
	const sourceUrl = validatedExternalMediaUrl(rawUrl);
	return validatedExternalMediaUrl(sourceUrl ? normalizePreviewImageUrl(sourceUrl) : null);
}

function uniqueImageUrls(candidates: Array<string | null | undefined>): string[] {
	return [...new Set(candidates.map(normalizedResourceImageUrl).filter((url): url is string => url !== null))];
}

export function resourcePreviewImageSourceUrls(resource: ResourceImageSourceRecord): string[] {
	const candidates: Array<string | null | undefined> = [];
	if (resource.kindMetadata && 'attachments' in resource.kindMetadata) {
		const post = resource.kindMetadata as PostKindMetadata;
		const mediaUrls = post.attachments.map((item) => item.url);
		candidates.push(mediaUrls[0], post.externalLink?.imageUrl, resource.ogImageUrl, ...mediaUrls.slice(1));
	} else {
		candidates.push(resource.ogImageUrl);
	}
	return uniqueImageUrls(candidates);
}

export function resourceImageSourceUrls(resource: ResourceImageSourceRecord): string[] {
	const avatarUrls = resource.creators?.map((creator) => creator.avatarUrl) ?? [];
	const quoteAvatarUrl =
		resource.kindMetadata && 'attachments' in resource.kindMetadata
			? (resource.kindMetadata as PostKindMetadata).quote?.creator.avatarUrl
			: undefined;
	return uniqueImageUrls([...resourcePreviewImageSourceUrls(resource), ...avatarUrls, quoteAvatarUrl]);
}

function rawResourceImageUrls(resource: ResourceImageSourceRecord): string[] {
	const metadata = resource.kindMetadata && 'attachments' in resource.kindMetadata ? (resource.kindMetadata as PostKindMetadata) : null;
	return [
		resource.ogImageUrl,
		...(resource.creators?.map((creator) => creator.avatarUrl) ?? []),
		...(metadata?.attachments.map((attachment) => attachment.url) ?? []),
		metadata?.externalLink?.imageUrl,
		metadata?.quote?.creator.avatarUrl,
	].filter((url): url is string => typeof url === 'string');
}

export async function resourceImageId(sourceUrl: string): Promise<string> {
	return RESOURCE_IMAGE_ID_PREFIX + (await sha256Hex(sourceUrl));
}

export function isResourceImageId(value: string): boolean {
	return RESOURCE_IMAGE_ID_PATTERN.test(value);
}

export function hostedResourceImageUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		const [accountHash, imageId, variant, ...rest] = url.pathname.split('/').filter(Boolean);
		if (
			url.protocol !== 'https:' ||
			url.hostname !== 'imagedelivery.net' ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!accountHash ||
			!/^[a-zA-Z0-9_-]+$/.test(accountHash) ||
			!imageId ||
			!isResourceImageId(imageId) ||
			variant !== 'public' ||
			rest.length > 0
		) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

export function resourceImageFieldsAreHosted(resource: ResourceImageSourceRecord): boolean {
	return rawResourceImageUrls(resource).every((url) => hostedResourceImageUrl(url) === url);
}

export function resourcePreviewImageUrl(resource: ResourceImageSourceRecord): string | null {
	for (const candidate of resourcePreviewImageSourceUrls(resource)) {
		const hosted = hostedResourceImageUrl(candidate);
		if (hosted) return hosted;
	}
	return null;
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
	resource: ResourceImageSourceRecord,
	images: readonly HostedResourceImage[],
): HostedResourceImageFields {
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
