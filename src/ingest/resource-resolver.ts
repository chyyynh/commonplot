import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '../shared/paper-identity.ts';
import {
	isPaperIdentifier,
	normalizeResourceIdentifiers,
	type PlatformResourceIdentifierScheme,
	type ResourceIdentifier,
} from '../shared/resource-identifiers.ts';
import {
	type ContentResourceIdentity,
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	resourceIdentityForDetectedPlatform,
} from '../shared/resource-types.ts';
import type { AcquiredMaterial, MaterializedResource, ResolvedResourceSubject } from '../shared/types.ts';
import { canonicalResourcePlatformUrl, detectResourceUrl, normalizeUrl } from '../shared/url.ts';

export type ResourcePlatformLocator = Readonly<{
	resourcePlatform: PlatformResourceIdentifierScheme;
	platformId: string;
}>;

export function exactPlatformLocator(identifiers: readonly ResourceIdentifier[]): ResourcePlatformLocator | null {
	const platformIdentifiers = normalizeResourceIdentifiers(identifiers).filter(
		(identifier): identifier is ResourceIdentifier & { scheme: PlatformResourceIdentifierScheme } =>
			identifier.scheme === 'hackernews' ||
			identifier.scheme === 'lesswrong' ||
			identifier.scheme === 'twitter' ||
			identifier.scheme === 'youtube',
	);
	const locators = new Map(platformIdentifiers.map((identifier) => [identifier.scheme, identifier.value]));
	if (locators.size > 1) throw new Error('Resource has conflicting exact platform identifiers');
	const [locator] = locators;
	return locator ? { resourcePlatform: locator[0], platformId: locator[1] } : null;
}

export function materializeAcquiredResource(
	acquired: AcquiredMaterial & { sourceSnapshotHash: string },
	origin: Pick<MaterializedResource, 'keywords' | 'normalizedUrl' | 'originalLang' | 'publishedDate' | 'summary' | 'tags' | 'url'>,
	resolution: {
		canonicalUrl: string | null;
		publishedDate: string | null;
		resourceIdentifiers: readonly ResourceIdentifier[];
	},
): MaterializedResource {
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
		sourceRevision: acquired.sourceSnapshotHash,
		resourceIdentifiers: identifiers,
		fileType: acquired.fileType,
		normalizedUrl: url ?? origin.normalizedUrl,
		previewImageUrl: acquired.previewImageUrl?.trim() || null,
		subject: resolvedSubjectInput(acquired.subjectUrl?.trim()),
	};
}

export function resolvedSubjectInput(subjectUrl: string | null | undefined): ResolvedResourceSubject | null {
	if (!subjectUrl) return null;
	const url = normalizeUrl(subjectUrl);
	const paper = resolveExactPaperInput(url);
	if (paper) {
		return {
			identifiers: paperIdentifiersFromIdentity(paper.identity),
			normalizedUrl: paper.canonicalUrl,
			url: paper.canonicalUrl,
		};
	}
	const detected = detectResourceUrl(url);
	return {
		identifiers: detected
			? normalizeResourceIdentifiers([{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }])
			: [],
		normalizedUrl: url,
		url,
	};
}
