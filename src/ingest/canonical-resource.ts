import { literalCreator, type PaperKindMetadata, type ResourceCreator, type ResourceKindMetadata } from '@core-shared/resource-metadata';
import type { AcquiredMaterial, PaperMetadata, ResourceForProcessing } from '@core-shared/types';
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

export function paperCanonicalFields(metadata: PaperMetadata): {
	creators: ResourceCreator[];
	kindMetadata: PaperKindMetadata;
} {
	return {
		creators: metadata.authors.flatMap((author) => literalCreator('author', author)),
		kindMetadata: {
			...(metadata.venue?.trim() ? { venue: metadata.venue.trim() } : {}),
			...(metadata.year === undefined ? {} : { year: metadata.year }),
			...(metadata.citedByCount === undefined ? {} : { citedByCount: metadata.citedByCount }),
			...(metadata.referenceCount === undefined ? {} : { referenceCount: metadata.referenceCount }),
			...(metadata.pdfUrl?.trim() ? { pdfUrl: metadata.pdfUrl.trim() } : {}),
			...(metadata.references ? { references: metadata.references } : {}),
			...(metadata.citations ? { citations: metadata.citations } : {}),
		},
	};
}

export function withPaperCanonicalFields(resource: ResourceForProcessing, metadata: PaperMetadata | null): ResourceForProcessing {
	if (!metadata) return resource;
	const canonical = paperCanonicalFields(metadata);
	return {
		...resource,
		creators: canonical.creators,
		kind_metadata: canonical.kindMetadata,
	};
}
