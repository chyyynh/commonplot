import { sha256Hex } from './hash.ts';
import type { PostKindMetadata, ResourceCreator, ResourceKindMetadata } from './resource-metadata.ts';
import { normalizePreviewImageUrl } from './url.ts';

export const RESOURCE_IMAGE_ID_PREFIX = 'resource-';

const RESOURCE_IMAGE_ID_PATTERN = /^resource-[a-f0-9]{64}$/;
const MAX_RESOURCE_IMAGE_REFS = 64;

export type ResourceImageSourceRecord = Readonly<{
	creators?: readonly ResourceCreator[] | null;
	kindMetadata?: ResourceKindMetadata | null;
	ogImageUrl?: string | null;
}>;

export type ResourceImageRef = Readonly<{
	deliveryUrl: string;
	imageId: string;
	sourceUrl: string;
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

export async function resourceImageId(sourceUrl: string): Promise<string> {
	return RESOURCE_IMAGE_ID_PREFIX + (await sha256Hex(sourceUrl));
}

export function isResourceImageId(value: string): boolean {
	return RESOURCE_IMAGE_ID_PATTERN.test(value);
}

function isResourceImageDeliveryUrl(value: string, imageId: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			url.hostname === 'imagedelivery.net' &&
			!url.username &&
			!url.password &&
			url.search === '' &&
			url.hash === '' &&
			url.pathname.endsWith(`/${imageId}/public`)
		);
	} catch {
		return false;
	}
}

export function parseResourceImageRefs(value: unknown): ResourceImageRef[] {
	if (!Array.isArray(value) || value.length > MAX_RESOURCE_IMAGE_REFS) {
		throw new TypeError('Resource image refs are invalid');
	}
	const sourceUrls = new Set<string>();
	const imageIds = new Set<string>();
	return value.map((item) => {
		if (!item || typeof item !== 'object') throw new TypeError('Resource image ref is invalid');
		const rawSourceUrl = 'sourceUrl' in item && typeof item.sourceUrl === 'string' ? item.sourceUrl : null;
		const sourceUrl = normalizedResourceImageUrl(rawSourceUrl);
		const imageId = 'imageId' in item && typeof item.imageId === 'string' ? item.imageId : '';
		const deliveryUrl = 'deliveryUrl' in item && typeof item.deliveryUrl === 'string' ? item.deliveryUrl : '';
		if (!sourceUrl || sourceUrl !== rawSourceUrl || !isResourceImageId(imageId) || !isResourceImageDeliveryUrl(deliveryUrl, imageId)) {
			throw new TypeError('Resource image ref is invalid');
		}
		if (sourceUrls.has(sourceUrl) || imageIds.has(imageId)) throw new TypeError('Resource image refs contain duplicates');
		sourceUrls.add(sourceUrl);
		imageIds.add(imageId);
		return { deliveryUrl, imageId, sourceUrl };
	});
}
