import type { ResourceCreator, ResourceIdentifier, ResourceKind, ResourceKindMetadata, ResourcePlatform } from '../shared/resource';
import type { ResourceSubjectIdentity } from './platforms/resource-url';

// Adapters share an output contract; each adapter owns its mapping and identity.
export type AcquiredResource = {
	citations?: { references: readonly { key: string; label: string | null; text: string }[] } | null;
	kind: Exclude<ResourceKind, 'image'>;
	resourcePlatform: ResourcePlatform | null;
	resourceIdentifiers: ResourceIdentifier[];
	url: string | null;
	title: string;
	summary: string | null;
	content: string;
	source: string;
	originalLang: string;
	publishedDate: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
	fileType: string | null;
	previewImageUrl: string | null;
	subject: ResourceSubjectIdentity | null;
};
