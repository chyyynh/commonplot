import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '../../shared/paper-identity.ts';
import {
	type ContentResourceIdentity,
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	isPaperIdentifier,
	normalizeResourceIdentifiers,
	type ResourceCreator,
	type ResourceIdentifier,
	type ResourceKindMetadata,
	type ResourcePlatform,
	type YouTubeHighlights,
	type YouTubeTranscript,
} from '../../shared/resource.ts';
import { canonicalResourcePlatformUrl, detectResourceUrl, normalizeUrl } from '../../shared/url.ts';

type ResolvedResourceSubject = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
}>;

type MaterializedResource = ContentResourceIdentity & {
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

export type YouTubeResourceSpecialization = Readonly<{
	kind: 'youtube';
	transcript: YouTubeTranscript | null;
	highlights: YouTubeHighlights | null;
}>;

export type ResolvedResource =
	| (Extract<MaterializedResource, { kind: 'video'; resourcePlatform: 'youtube' }> & {
			specialization: YouTubeResourceSpecialization;
	  })
	| (Exclude<MaterializedResource, { kind: 'video'; resourcePlatform: 'youtube' }> & {
			specialization: null;
	  });

export type AcquiredMaterial<T extends ResourcePlatform = ResourcePlatform> = T extends unknown
	? {
			resourcePlatform: T;
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
		} & (T extends Exclude<ResourcePlatform, null> ? { platformId: string } : unknown)
	: never;

export type AcquiredResource =
	| (Exclude<AcquiredMaterial, AcquiredMaterial<'youtube'>> & { specialization: null })
	| (AcquiredMaterial<'youtube'> & { specialization: YouTubeResourceSpecialization });

const DETECTED_PLATFORM_RESOURCE_IDENTITIES = {
	hackernews: { kind: 'forum', resourcePlatform: 'hackernews' },
	lesswrong: { kind: 'blog', resourcePlatform: 'lesswrong' },
	twitter: { kind: 'post', resourcePlatform: 'twitter' },
	youtube: { kind: 'video', resourcePlatform: 'youtube' },
} as const satisfies Readonly<Record<Exclude<ResourcePlatform, null>, ContentResourceIdentity>>;

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

type MaterializedAcquisition<T extends AcquiredResource> = Extract<ResolvedResource, { resourcePlatform: T['resourcePlatform'] }>;
type PlatformAcquiredResource = Exclude<AcquiredResource, { resourcePlatform: null }>;

export function materializeAcquiredResource<const T extends AcquiredResource>(
	acquired: T,
	origin: ResourceAcquisitionOrigin,
	resolution: { canonicalUrl: string | null; publishedDate: string | null; resourceIdentifiers: readonly ResourceIdentifier[] },
): MaterializedAcquisition<T> {
	const platformIdentity =
		acquired.resourcePlatform === null ? null : { resourcePlatform: acquired.resourcePlatform, platformId: acquired.platformId };
	const paperIdentifiers = resolution.resourceIdentifiers.filter(isPaperIdentifier);
	const identity: ContentResourceIdentity = platformIdentity
		? DETECTED_PLATFORM_RESOURCE_IDENTITIES[platformIdentity.resourcePlatform]
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
	} as MaterializedAcquisition<T>;
}

export function materializePlatformResource<const T extends PlatformAcquiredResource>(
	acquired: T,
	origin: ResourceAcquisitionOrigin,
): MaterializedAcquisition<T> {
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
