import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '../../shared/paper-identity.ts';
import {
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	isPaperIdentifier,
	normalizeResourceIdentifiers,
	RESOURCE_TYPES,
	type ResourceCreator,
	type ResourceIdentifier,
	type ResourceKindMetadata,
	type ResourceSpecialization,
} from '../../shared/resource.ts';
import { canonicalResourcePlatformUrl, detectResourceUrl, normalizeUrl } from '../../shared/url.ts';

type ResolvedResourceSubject = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
}>;

type MaterializedResource = Readonly<{
	kind: Exclude<(typeof RESOURCE_TYPES.kinds.options)[number], 'image' | 'file'>;
	resourcePlatform: (typeof RESOURCE_TYPES.platforms.options)[number] | null;
}> & {
	originalLang: string;
	title: string;
	summary: string | null;
	content: string;
	url: string | null;
	source: string;
	publishedDate: string | null;
	tags: string[];
	keywords: string[];
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata | null;
	resourceIdentifiers: ResourceIdentifier[];
	fileType: string | null;
	normalizedUrl: string | null;
	previewImageUrl: string | null;
	subject: ResolvedResourceSubject | null;
};

export type ResolvedResource = MaterializedResource & {
	specialization: ResourceSpecialization;
};

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
	T extends (typeof RESOURCE_TYPES.platforms.options)[number] = (typeof RESOURCE_TYPES.platforms.options)[number],
> = AcquiredMaterialFields & {
	platformId: string;
	resourcePlatform: T;
};

export type AcquiredResource = (GenericAcquiredMaterial | PlatformAcquiredMaterial) & {
	specialization: ResourceSpecialization;
};

export function literalCreator(
	role: ResourceCreator['role'],
	literal: string | null | undefined,
	extra: Omit<ResourceCreator, 'literal' | 'role'> = {},
): ResourceCreator[] {
	const name = literal?.trim();
	return name ? [{ role, literal: name, ...extra }] : [];
}

export type ResourceAcquisitionOrigin = Pick<
	MaterializedResource,
	'keywords' | 'normalizedUrl' | 'originalLang' | 'publishedDate' | 'resourceIdentifiers' | 'summary' | 'tags' | 'url'
>;

type PlatformAcquiredResource = PlatformAcquiredMaterial & Pick<AcquiredResource, 'specialization'>;

export function materializeAcquiredResource(
	acquired: AcquiredResource,
	origin: ResourceAcquisitionOrigin,
	resolution: { canonicalUrl: string | null; publishedDate: string | null; resourceIdentifiers: readonly ResourceIdentifier[] },
): ResolvedResource {
	const platformIdentity =
		acquired.resourcePlatform === null ? null : { resourcePlatform: acquired.resourcePlatform, platformId: acquired.platformId };
	const paperIdentifiers = resolution.resourceIdentifiers.filter(isPaperIdentifier);
	const identity: Pick<MaterializedResource, 'kind' | 'resourcePlatform'> = platformIdentity
		? { kind: RESOURCE_TYPES.platformKinds[platformIdentity.resourcePlatform], resourcePlatform: platformIdentity.resourcePlatform }
		: paperIdentifiers.some((identifier) => identifier.scheme === 'openalex')
			? { kind: 'paper', resourcePlatform: null }
			: { kind: 'blog', resourcePlatform: null };
	const identifiers = normalizeResourceIdentifiers(
		platformIdentity
			? [{ preferred: true, scheme: platformIdentity.resourcePlatform, value: platformIdentity.platformId }]
			: identity.kind === 'paper'
				? paperIdentifiers
				: [],
	);
	const url = platformIdentity
		? canonicalResourcePlatformUrl(platformIdentity.resourcePlatform, platformIdentity.platformId)
		: resolution.canonicalUrl;
	return {
		...identity,
		originalLang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeResourceLang(origin.originalLang),
		title: acquired.title.trim(),
		summary: acquired.summary ?? origin.summary,
		content: acquired.markdown,
		url,
		source: acquired.source,
		publishedDate: resolution.publishedDate,
		tags: origin.tags,
		keywords: origin.keywords,
		creators: acquired.creators,
		kindMetadata: acquired.kindMetadata,
		resourceIdentifiers: identifiers,
		fileType: acquired.fileType,
		normalizedUrl: url ?? origin.normalizedUrl,
		previewImageUrl: acquired.previewImageUrl?.trim() || null,
		subject: resolvedSubjectInput(acquired.subjectUrl?.trim()),
		specialization: acquired.specialization,
	};
}

export function materializePlatformResource(acquired: PlatformAcquiredResource, origin: ResourceAcquisitionOrigin): ResolvedResource {
	let publishedDate = origin.publishedDate;
	if (acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	return materializeAcquiredResource(acquired, origin, { canonicalUrl: null, publishedDate, resourceIdentifiers: [] });
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
		identifiers: detected
			? normalizeResourceIdentifiers([{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }])
			: [],
		normalizedUrl,
	};
}
