import { literalCreator, type ResourceCreator, type ResourceKindMetadata } from '@core-shared/resource-metadata';
import type { AcquiredMaterial } from '@core-shared/types';
import { canonicalForumFields } from './platforms/hackernews';
import { canonicalPostFields } from './platforms/twitter-acquisition';
import { canonicalVideoFields } from './platforms/youtube-acquisition';

type CanonicalAcquisitionFields = Readonly<{
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
}>;

export function canonicalFieldsFromAcquisition(acquired: AcquiredMaterial): CanonicalAcquisitionFields {
	switch (acquired.provider) {
		case null:
			return {
				creators: literalCreator('author', acquired.metadata.author),
				kindMetadata: acquired.metadata.siteName.trim() ? { siteName: acquired.metadata.siteName.trim() } : null,
			};
		case 'hackernews':
			return canonicalForumFields(acquired.acquisition);
		case 'twitter':
			return canonicalPostFields(acquired.acquisition);
		case 'youtube':
			return canonicalVideoFields(acquired.acquisition);
	}
}
