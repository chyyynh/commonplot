import { type PaperIdentifier, paperIdentifiersFromIdentity, resolveExactPaperInput } from '../../shared/paper-identity.ts';
import {
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
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
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number] | null;
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
		(typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number] = (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number],
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

export type ResourceAcquisitionOrigin = Pick<
	MaterializedResource,
	'keywords' | 'normalizedUrl' | 'originalLang' | 'publishedDate' | 'summary' | 'tags' | 'url'
> & { resourceIdentifiers: PaperIdentifier[] };

export function materializeAcquiredResource(
	acquired: AcquiredResource,
	origin: ResourceAcquisitionOrigin,
	resolution: { canonicalUrl: string | null; publishedDate: string | null; resourceIdentifiers: readonly PaperIdentifier[] },
): ResolvedResource {
	const platformIdentity =
		acquired.resourcePlatform === null ? null : { resourcePlatform: acquired.resourcePlatform, platformId: acquired.platformId };
	let identity: Pick<MaterializedResource, 'kind' | 'resourcePlatform'>;
	if (platformIdentity) {
		const kind = Object.entries(RESOURCE_TYPES).find(([, { platforms }]) =>
			platforms.some((platform) => platform === platformIdentity.resourcePlatform),
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
	};
}

export function materializePlatformResource(acquired: PlatformAcquiredMaterial, origin: ResourceAcquisitionOrigin): ResolvedResource {
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
		identifiers: detected ? [{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }] : [],
		normalizedUrl,
	};
}
