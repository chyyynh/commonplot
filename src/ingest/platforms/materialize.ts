import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '../../shared/paper-identity.ts';
import { isPaperIdentifier, normalizeResourceIdentifiers, type ResourceIdentifier } from '../../shared/resource-identifiers.ts';
import {
	type ContentResourceIdentity,
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	resourceIdentityForDetectedPlatform,
} from '../../shared/resource-types.ts';
import type { AcquiredResource, MaterializedResource, ResolvedResource, ResolvedResourceSubject } from '../../shared/types.ts';
import { canonicalResourcePlatformUrl, detectResourceUrl, normalizeUrl } from '../../shared/url.ts';

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
		? resourceIdentityForDetectedPlatform(platformIdentity.resourcePlatform)
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
