import type {
	PersistResolvedResourceInput,
	PersistResolvedResourceResult,
	PersistResolvedResourceTarget,
} from '@app-domain/resource-graph-contracts';
import { type HostedResourceImage, hostedResourceImageFields } from '@core-shared/resource-image-mapping';
import type { ResolvedResource } from '@core-shared/types';
import { toStoredResourceEntities } from '@entities/normalize';
import type { ResourceClassificationResult } from './domain/resource-classification';

export type PersistProcessedTarget = PersistResolvedResourceTarget;

type PersistProcessedInput = {
	classification: ResourceClassificationResult;
	resource: ResolvedResource;
	target: PersistProcessedTarget;
};

export async function persistProcessedResource(
	env: CoreEnv,
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Promise<PersistResolvedResourceResult> {
	return env.DOMAIN.persistResolvedResource({ ...resolvedResourceMutation(input, hostedImages), target: input.target });
}

function resolvedResourceMutation(
	input: PersistProcessedInput,
	hostedImages: readonly HostedResourceImage[],
): Omit<PersistResolvedResourceInput, 'target'> {
	const resource = input.resource;
	const ogImageUrl = resource.previewImageUrl;
	const media = hostedResourceImageFields({ creators: resource.creators, kindMetadata: resource.kindMetadata, ogImageUrl }, hostedImages);
	const youtube =
		resource.specialization?.kind === 'youtube'
			? { transcript: resource.specialization.transcript, highlights: resource.specialization.highlights }
			: null;
	return {
		identity: resource,
		identifiers: resource.resourceIdentifiers,
		creators: media.creators,
		kindMetadata: media.kindMetadata,
		youtube,
		originalLang: resource.originalLang,
		title: resource.title,
		summary: resource.summary,
		content: resource.content,
		keywords: input.classification.keywords,
		tags: input.classification.tags,
		category: input.classification.category,
		entities: toStoredResourceEntities(input.classification.entities, resource.resourcePlatform, resource.source, resource.creators),
		subjectReference: resource.subject
			? {
					identifiers: resource.subject.identifiers,
					normalizedUrl: resource.subject.normalizedUrl,
				}
			: null,
		url: resource.url,
		normalizedUrl: resource.normalizedUrl ?? resource.url,
		fileType: resource.fileType ?? null,
		publishedDate: resource.publishedDate,
		ogImageUrl: media.ogImageUrl,
	};
}
