import { type PaperIdentifier, paperIdentifiersFromIdentity, resolveExactPaperInput } from '../../shared/paper-identity.ts';
import {
	canonicalizeOptionalResourceLang,
	RESOURCE_TYPES,
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

export type AcquiredResource = GenericAcquiredMaterial | PlatformAcquiredMaterial;

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

export function materializeAcquiredResource(
	acquired: AcquiredResource,
	hints: ResourceAcquisitionHints,
	resolution: { canonicalUrl: string | null; publishedDate: string | null; resourceIdentifiers: readonly PaperIdentifier[] },
): ResolvedResource {
	const platformIdentity =
		acquired.resourcePlatform === null ? null : { resourcePlatform: acquired.resourcePlatform, platformId: acquired.platformId };
	let identity: Pick<MaterializedResource, 'kind' | 'resourcePlatform'>;
	if (platformIdentity) {
		const kind = Object.entries(RESOURCE_TYPES).find(([, { platforms }]) =>
			platforms.some(({ name }) => name === platformIdentity.resourcePlatform),
		)?.[0] as Exclude<keyof typeof RESOURCE_TYPES, 'image' | 'file'> | undefined;
		if (!kind) throw new Error(`Unknown Resource platform: ${platformIdentity.resourcePlatform}`);
		identity = { kind, resourcePlatform: platformIdentity.resourcePlatform };
	} else {
		identity = resolution.resourceIdentifiers.some((identifier) => identifier.scheme === 'openalex')
			? { kind: 'paper', resourcePlatform: null }
			: { kind: 'blog', resourcePlatform: null };
	}
	const identifiers: ResourceIdentifier[] = platformIdentity
		? [{ preferred: true, scheme: platformIdentity.resourcePlatform, value: platformIdentity.platformId }]
		: identity.kind === 'paper'
			? [...resolution.resourceIdentifiers]
			: [];
	const url = platformIdentity
		? canonicalResourcePlatformUrl(platformIdentity.resourcePlatform, platformIdentity.platformId)
		: resolution.canonicalUrl;
	return {
		...identity,
		originalLang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeOptionalResourceLang(hints.originalLang) ?? 'en',
		title: acquired.title.trim(),
		summary: acquired.summary ?? hints.summary,
		content: acquired.markdown,
		url,
		source: acquired.source,
		publishedDate: resolution.publishedDate,
		creators: acquired.creators,
		kindMetadata: acquired.kindMetadata,
		resourceIdentifiers: identifiers,
		fileType: acquired.fileType,
		normalizedUrl: url,
		previewImageUrl: acquired.previewImageUrl?.trim() || null,
		subject: resolvedSubjectInput(acquired.subjectUrl?.trim()),
	};
}

export function materializePlatformResource(acquired: PlatformAcquiredMaterial, hints: ResourceAcquisitionHints): ResolvedResource {
	let publishedDate = hints.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	return materializeAcquiredResource(acquired, hints, { canonicalUrl: null, publishedDate, resourceIdentifiers: [] });
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
