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
import type { AcquiredMaterial, ResolvedResource, ResourceForProcessing } from '../shared/types.ts';
import { canonicalResourcePlatformUrl, detectResourceUrl, normalizeUrl } from '../shared/url.ts';

type ExactPlatformLocator = Readonly<{
	resourcePlatform: PlatformResourceIdentifierScheme;
	platformId: string;
}>;

export function exactPlatformLocator(identifiers: readonly ResourceIdentifier[]): ExactPlatformLocator | null {
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
	origin: Pick<
		ResourceForProcessing,
		| 'keywords'
		| 'normalizedUrl'
		| 'originalLang'
		| 'processingId'
		| 'publishedDate'
		| 'scope'
		| 'sourceId'
		| 'storageKey'
		| 'summary'
		| 'tags'
		| 'url'
	>,
	resolution: {
		canonicalUrl: string | null;
		detected: ReturnType<typeof detectResourceUrl>;
		publishedDate: string | null;
		resourceIdentifiers: readonly ResourceIdentifier[];
	},
): ResolvedResource {
	const paperIdentifiers = resolution.resourceIdentifiers.filter(isPaperIdentifier);
	const identity: ContentResourceIdentity = resolution.detected
		? resourceIdentityForDetectedPlatform(resolution.detected.resourcePlatform)
		: paperIdentifiers.some((identifier) => identifier.scheme === 'openalex')
			? { kind: 'paper', resourcePlatform: null }
			: { kind: 'blog', resourcePlatform: null };
	const identifiers = normalizeResourceIdentifiers(
		resolution.detected
			? [{ preferred: true, scheme: resolution.detected.resourcePlatform, value: resolution.detected.platformId }]
			: identity.kind === 'paper'
				? paperIdentifiers
				: [],
	);
	const url = resolution.detected
		? canonicalResourcePlatformUrl(resolution.detected.resourcePlatform, resolution.detected.platformId)
		: resolution.canonicalUrl;
	return {
		...identity,
		processingId: origin.processingId,
		sourceId: origin.sourceId,
		scope: origin.scope,
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
		storageKey: origin.scope === 'private' ? origin.storageKey : null,
		fileType: acquired.fileType,
		normalizedUrl: url ?? origin.normalizedUrl,
	};
}

export type ResolvedSubjectInput = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
	url: string;
}>;

export function resolvedSubjectInput(subjectUrl: string | null | undefined): ResolvedSubjectInput | null {
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
