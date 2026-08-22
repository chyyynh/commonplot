import type { PostKindMetadata, ResourceCreator, ResourceKindMetadata } from './resource.ts';

const HOSTED_RESOURCE_IMAGE_PATTERN = /^https:\/\/imagedelivery\.net\/[a-zA-Z0-9_-]+\/resource-[a-f0-9]{64}\/public$/;

export type ResourceImageFields = Readonly<{
	creators?: readonly ResourceCreator[] | null;
	kindMetadata?: ResourceKindMetadata | null;
	ogImageUrl?: string | null;
}>;

export function resourcePostMetadata(resource: ResourceImageFields): PostKindMetadata | null {
	return resource.kindMetadata && 'attachments' in resource.kindMetadata ? (resource.kindMetadata as PostKindMetadata) : null;
}

function resourcePreviewImageCandidates(resource: ResourceImageFields): string[] {
	const metadata = resourcePostMetadata(resource);
	const attachments = metadata?.attachments.map((item) => item.url) ?? [];
	return [attachments[0], resource.ogImageUrl, ...attachments.slice(1)].filter((url): url is string => typeof url === 'string');
}

export function resourceImageCandidates(resource: ResourceImageFields): string[] {
	const metadata = resourcePostMetadata(resource);
	return [
		...resourcePreviewImageCandidates(resource),
		...(resource.creators?.map((creator) => creator.avatarUrl) ?? []),
		metadata?.quote?.creator.avatarUrl,
	].filter((url): url is string => typeof url === 'string');
}

export function hostedResourceImageUrl(value: string | null | undefined): string | null {
	const url = value?.trim();
	return url && HOSTED_RESOURCE_IMAGE_PATTERN.test(url) ? url : null;
}

export function resourceImageFieldsAreHosted(resource: ResourceImageFields): boolean {
	return resourceImageCandidates(resource).every((url) => hostedResourceImageUrl(url) === url);
}

export function resourcePreviewImageUrl(resource: ResourceImageFields): string | null {
	for (const candidate of resourcePreviewImageCandidates(resource)) {
		const hosted = hostedResourceImageUrl(candidate);
		if (hosted) return hosted;
	}
	return null;
}
