import type { PaperIdentifier } from '../../shared/paper-identity.ts';
import {
	canonicalizeOptionalResourceLang,
	type ResourceCreator,
	type ResourceIdentifier,
	type ResourceKind,
	type ResourceKindForPlatform,
	type ResourceKindMetadata,
	type ResourcePlatform,
	type ResourcePlatformKindMetadata,
} from '../../shared/resource.ts';

export type ResolvedResourceSubject = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
}>;

type MaterializedResource = Readonly<{
	kind: Exclude<ResourceKind, 'image' | 'file'>;
	resourcePlatform: ResourcePlatform | null;
}> & {
	originalLang: string;
	title: string;
	summary: string | null;
	content: string;
	url: string | null;
	source: string;
	publishedDate: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata | null;
	resourceIdentifiers: ResourceIdentifier[];
	fileType: string | null;
	normalizedUrl: string | null;
	previewImageUrl: string | null;
	subject: ResolvedResourceSubject | null;
};

export type ResolvedResource = MaterializedResource;

type AcquiredMaterialFields<TKindMetadata extends ResourceKindMetadata = ResourceKindMetadata> = {
	canonicalUrl?: string;
	fileType: string | null;
	title: string;
	markdown: string;
	paperIdentifierText?: string | null;
	previewImageUrl?: string | null;
	subjectUrl?: string;
	source: string;
	originalLang: string | null;
	publishedDate: string | null;
	summary: string | null;
	creators: ResourceCreator[];
	kindMetadata: TKindMetadata;
};

export type GenericAcquiredMaterial = AcquiredMaterialFields & {
	resourcePlatform: null;
};

export type PlatformAcquiredMaterial<TPlatform extends ResourcePlatform = ResourcePlatform> = AcquiredMaterialFields<
	ResourcePlatformKindMetadata<TPlatform>
> & {
	platformId: string;
	resourcePlatform: TPlatform;
};

export type PlatformResourceUrl = Readonly<{
	canonicalUrl: string;
	platformId: string;
	resourcePlatform: ResourcePlatform;
}>;

export function literalCreator(
	role: ResourceCreator['role'],
	literal: string | null | undefined,
	extra: Omit<ResourceCreator, 'literal' | 'role'> = {},
): ResourceCreator[] {
	const name = literal?.trim();
	return name ? [{ role, literal: name, ...extra }] : [];
}

export type ResourceAcquisitionHints = Readonly<{
	originalLang: string | null;
	publishedDate: string | null;
	summary: string | null;
}>;

function materializeResource(
	acquired: AcquiredMaterialFields,
	hints: ResourceAcquisitionHints,
	identity: Pick<MaterializedResource, 'kind' | 'resourcePlatform' | 'url'> & {
		resourceIdentifiers: readonly ResourceIdentifier[];
	},
	publishedDate: string | null,
	subject: ResolvedResourceSubject | null,
): ResolvedResource {
	return {
		...identity,
		originalLang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeOptionalResourceLang(hints.originalLang) ?? 'en',
		title: acquired.title.trim(),
		summary: acquired.summary ?? hints.summary,
		content: acquired.markdown,
		source: acquired.source,
		publishedDate,
		creators: acquired.creators,
		kindMetadata: acquired.kindMetadata,
		resourceIdentifiers: [...identity.resourceIdentifiers],
		fileType: acquired.fileType,
		normalizedUrl: identity.url,
		previewImageUrl: acquired.previewImageUrl?.trim() || null,
		subject,
	};
}

export function materializeGenericResource(
	acquired: GenericAcquiredMaterial,
	hints: ResourceAcquisitionHints,
	resolution: {
		canonicalUrl: string | null;
		identity:
			| Readonly<{ kind: 'blog'; resourceIdentifiers: readonly [] }>
			| Readonly<{ kind: 'paper'; resourceIdentifiers: readonly PaperIdentifier[] }>;
		publishedDate: string | null;
	},
): ResolvedResource {
	return materializeResource(
		acquired,
		hints,
		{
			kind: resolution.identity.kind,
			resourceIdentifiers: resolution.identity.resourceIdentifiers,
			resourcePlatform: null,
			url: resolution.canonicalUrl,
		},
		resolution.publishedDate,
		null,
	);
}

export function materializePlatformResource<TPlatform extends ResourcePlatform>(
	acquired: PlatformAcquiredMaterial<TPlatform>,
	hints: ResourceAcquisitionHints,
	identity: Pick<MaterializedResource, 'url'> & { kind: ResourceKindForPlatform<TPlatform> },
	subject: ResolvedResourceSubject | null = null,
): ResolvedResource {
	let publishedDate = hints.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	return materializeResource(
		acquired,
		hints,
		{
			...identity,
			resourceIdentifiers: [{ preferred: true, scheme: acquired.resourcePlatform, value: acquired.platformId }],
			resourcePlatform: acquired.resourcePlatform,
		},
		publishedDate,
		subject,
	);
}
