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

export type ResolvedResourceSubjectIdentity = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
}>;

// A subject page usually publishes no date of its own, so the carrier's
// publication time travels with the subject as an acquisition hint.
export type ResolvedResourceSubject = ResolvedResourceSubjectIdentity & Readonly<{ publishedDate: string | null }>;

export type ResolvedResource = Readonly<{
	kind: Exclude<ResourceKind, 'image'>;
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

type AcquiredMaterialFields<TKindMetadata extends ResourceKindMetadata = ResourceKindMetadata> = {
	fileType: string | null;
	title: string;
	markdown: string;
	previewImageUrl?: string | null;
	source: string;
	originalLang: string | null;
	publishedDate: string | null;
	summary: string | null;
	creators: ResourceCreator[];
	kindMetadata: TKindMetadata;
};

export type GenericAcquiredMaterial = AcquiredMaterialFields & {
	canonicalUrl?: string;
	paperIdentifierText?: string | null;
	resourcePlatform: null;
};

export type PlatformAcquiredMaterial<TPlatform extends ResourcePlatform = ResourcePlatform> = AcquiredMaterialFields<
	ResourcePlatformKindMetadata<TPlatform>
> & {
	platformId: string;
	resourcePlatform: TPlatform;
	subjectUrl?: string;
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
	identity: Pick<ResolvedResource, 'kind' | 'resourcePlatform' | 'url'> & {
		resourceIdentifiers: readonly ResourceIdentifier[];
	},
	publishedDate: string | null,
	subject: ResolvedResourceSubject | null,
): ResolvedResource {
	return {
		...identity,
		originalLang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeOptionalResourceLang(hints.originalLang) ?? 'und',
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
		publishedDate: string | null;
		resourceIdentifiers: readonly PaperIdentifier[];
	},
): ResolvedResource {
	const isPaper = resolution.resourceIdentifiers.some(({ scheme }) => scheme === 'openalex');
	const kind = isPaper ? 'paper' : acquired.fileType === 'application/pdf' ? 'file' : 'blog';
	return materializeResource(
		kind === 'file' ? { ...acquired, kindMetadata: null } : acquired,
		hints,
		{
			kind,
			resourceIdentifiers: isPaper ? resolution.resourceIdentifiers : [],
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
	identity: Pick<ResolvedResource, 'url'> & { kind: ResourceKindForPlatform<TPlatform> },
	subject: ResolvedResourceSubjectIdentity | null = null,
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
		subject && { ...subject, publishedDate },
	);
}
