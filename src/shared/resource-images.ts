import { sha256Hex } from './hash';
import type { PostKindMetadata, ResourceKindMetadata } from './resource-metadata';
import { normalizePreviewImageUrl } from './url';

export const RESOURCE_IMAGE_PREFIX = 'resource-images/originals/';
export const RESOURCE_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const RESOURCE_IMAGE_HASH_PATTERN = /^[a-f0-9]{64}$/;

export type ResourceImageSourceRecord = Readonly<{
	kindMetadata?: ResourceKindMetadata | null;
	ogImageUrl?: string | null;
}>;

export type ResourceImagePlan = Readonly<{
	revision: string | null;
	urls: readonly string[];
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

export function resourceImageSourceUrls(resource: ResourceImageSourceRecord): string[] {
	const candidates: Array<string | null | undefined> = [];
	if (resource.kindMetadata && 'attachments' in resource.kindMetadata) {
		const post = resource.kindMetadata as PostKindMetadata;
		const mediaUrls = post.attachments.map((item) => item.url);
		candidates.push(mediaUrls[0], post.externalLink?.imageUrl, resource.ogImageUrl, ...mediaUrls.slice(1));
	} else {
		candidates.push(resource.ogImageUrl);
	}
	return [...new Set(candidates.map(normalizedResourceImageUrl).filter((url): url is string => url !== null))];
}

export async function createResourceImagePlan(resource: ResourceImageSourceRecord): Promise<ResourceImagePlan> {
	const urls = resourceImageSourceUrls(resource);
	return {
		revision: urls.length > 0 ? await sha256Hex(JSON.stringify(urls)) : null,
		urls,
	};
}

export function isResourceImageRevision(value: string): boolean {
	return RESOURCE_IMAGE_HASH_PATTERN.test(value);
}

export async function resourceImageStorageKey(sourceUrl: string): Promise<string> {
	return RESOURCE_IMAGE_PREFIX + (await sha256Hex(sourceUrl));
}

export function isResourceImageStorageKey(key: string): boolean {
	return key.startsWith(RESOURCE_IMAGE_PREFIX) && RESOURCE_IMAGE_HASH_PATTERN.test(key.slice(RESOURCE_IMAGE_PREFIX.length));
}
