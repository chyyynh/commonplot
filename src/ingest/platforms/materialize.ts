import { type PaperIdentifier, paperIdentifiersFromIdentity, resolveExactPaperInput } from '../../shared/paper-identity.ts';
import {
	canonicalizeOptionalResourceLang,
	type RESOURCE_TYPES,
	type ResourceCreator,
	type ResourceIdentifier,
	type ResourceKindMetadata,
} from '../../shared/resource.ts';
import { canonicalResourcePlatformUrl, detectResourceUrl, normalizeUrl } from '../../shared/url.ts';

type ResolvedResourceSubject = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
}>;

type MaterializedResource = Readonly<{
	kind: Exclude<keyof typeof RESOURCE_TYPES, 'image' | 'file'>;
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null;
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

type AcquiredMaterialFields = {
	canonicalUrl?: string;
	fileType: string | null;
	title: string;
	markdown: string;
	previewImageUrl?: string | null;
	subjectUrl?: string;
	source: string;
	originalLang: string | null;
	publishedDate: string | null;
	summary: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
};

export type GenericAcquiredMaterial = AcquiredMaterialFields & {
	resourcePlatform: null;
};

export type PlatformAcquiredMaterial<
	T extends
		(typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] = (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'],
> = AcquiredMaterialFields & {
	platformId: string;
	resourcePlatform: T;
};

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
		subject: resolvedSubjectInput(acquired.subjectUrl?.trim()),
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
	);
}

export function materializePlatformResource(
	acquired: PlatformAcquiredMaterial,
	hints: ResourceAcquisitionHints,
	identity: Pick<MaterializedResource, 'kind' | 'url'>,
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
	);
}

function resolvedSubjectInput(subjectUrl: string | null | undefined): ResolvedResourceSubject | null {
	if (!subjectUrl) return null;
	const paper = resolveExactPaperInput(subjectUrl);
	if (paper) {
		return {
			identifiers: paperIdentifiersFromIdentity(paper.identity),
			normalizedUrl: paper.canonicalUrl,
		};
	}
	const detected = detectResourceUrl(subjectUrl);
	const normalizedUrl = detected ? canonicalResourcePlatformUrl(detected.resourcePlatform, detected.platformId) : normalizeUrl(subjectUrl);
	return {
		identifiers: detected ? [{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }] : [],
		normalizedUrl,
	};
}
