// Pure Resource image selection and Hosted Images URL mapping; Cloudflare I/O lives in image-rehosting.ts.
import type { ResourceCreator, ResourceKindMetadata } from './resource-kinds.ts';

const HOSTED_RESOURCE_IMAGE_PATTERN = /^https:\/\/imagedelivery\.net\/[a-zA-Z0-9_-]+\/resource-[a-f0-9]{64}\/public$/;
const PREVIEW_IMAGE_TARGET_WIDTH = 1200;
const WORDPRESS_UPLOAD_PATH = /\/wp-content\/uploads\//i;

type ResourceImageFields = Readonly<{
	creators: readonly ResourceCreator[];
	kindMetadata: ResourceKindMetadata | null;
	previewImageUrl: string | null;
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

export type ResourceImageSources = Readonly<{ urls: readonly string[]; optional: ReadonlySet<string> }>;

/**
 * Every image the resources reference, in a stable order. A preview or avatar that nothing else uses is
 * optional: it is decoration, so a dead one is dropped instead of failing the resource.
 */
export function resourceImageSources(resources: readonly ResourceImageFields[]): ResourceImageSources {
	const urls = new Set<string>();
	const required = new Set<string>();
	const decorative = new Set<string>();
	const add = (candidate: string | null | undefined, optional = false) => {
		if (candidate === null || candidate === undefined) return;
		const url = normalizedResourceImageUrl(candidate);
		if (!url) throw new TypeError('Resource image source URL is invalid');
		urls.add(url);
		(optional ? decorative : required).add(url);
	};
	for (const resource of resources) {
		const attachments = attachmentUrls(resource.kindMetadata);
		add(attachments[0]);
		add(resource.previewImageUrl, true);
		for (const url of attachments.slice(1)) add(url);
		for (const creator of resource.creators) add(creator.avatarUrl, true);
	}
	return { urls: [...urls], optional: new Set([...decorative].filter((url) => !required.has(url))) };
}

function attachmentUrls(metadata: ResourceKindMetadata | null): string[] {
	return metadata && 'attachments' in metadata ? metadata.attachments.map((item) => item.url) : [];
}

export type HostedPreview = Readonly<{ previewImageWidth: number | null; previewImageHeight: number | null }>;

/** Substitute Hosted Images URLs for every source; a preview or avatar that could not be hosted is dropped. */
export function withHostedImages<T extends ResourceImageFields>(resource: T, images: readonly HostedResourceImage[]): T & HostedPreview {
	const bySource = new Map(images.map((image) => [image.sourceUrl, image]));
	const hosted = (rawUrl: string) => bySource.get(normalizedResourceImageUrl(rawUrl) ?? '');
	const required = (rawUrl: string) => {
		const image = hosted(rawUrl);
		if (!image) throw new TypeError('Resource image was not hosted');
		return image.deliveryUrl;
	};
	const metadata = resource.kindMetadata;
	const preview = resource.previewImageUrl === null ? undefined : hosted(resource.previewImageUrl);
	return {
		...resource,
		creators: resource.creators.map(({ avatarUrl, ...creator }) => {
			const avatar = avatarUrl === undefined ? undefined : hosted(avatarUrl);
			return avatar ? { ...creator, avatarUrl: avatar.deliveryUrl } : creator;
		}),
		kindMetadata:
			metadata && 'attachments' in metadata
				? { ...metadata, attachments: metadata.attachments.map((attachment) => ({ ...attachment, url: required(attachment.url) })) }
				: metadata,
		previewImageUrl: preview?.deliveryUrl ?? null,
		previewImageWidth: preview?.width ?? null,
		previewImageHeight: preview?.height ?? null,
	};
}
