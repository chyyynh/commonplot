import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '../shared/paper-identity.ts';
import {
	isPaperIdentifier,
	normalizeResourceIdentifiers,
	type PlatformResourceIdentifierScheme,
	type ResourceIdentifier,
} from '../shared/resource-identifiers.ts';
import { type ContentResourceIdentity, resourceIdentityForDetectedPlatform, toResourceIdentityColumns } from '../shared/resource-types.ts';
import type { ResourceForProcessing } from '../shared/types.ts';
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

export function resolveContentResource(resource: ResourceForProcessing): ResourceForProcessing {
	const detected = resource.url ? detectResourceUrl(resource.url) : null;
	const paperIdentifiers = resource.resource_identifiers.filter(isPaperIdentifier);
	const identity: ContentResourceIdentity = detected
		? resourceIdentityForDetectedPlatform(detected.resourcePlatform)
		: paperIdentifiers.some((identifier) => identifier.scheme === 'openalex')
			? { kind: 'paper', resourcePlatform: null }
			: { kind: 'blog', resourcePlatform: null };
	const identifiers = normalizeResourceIdentifiers(
		detected
			? [{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }]
			: identity.kind === 'paper'
				? paperIdentifiers
				: [],
	);
	const url = detected ? canonicalResourcePlatformUrl(detected.resourcePlatform, detected.platformId) : resource.url;
	return {
		...resource,
		...toResourceIdentityColumns(identity),
		resource_identifiers: identifiers,
		url,
		normalized_url: url ?? resource.normalized_url ?? null,
	};
}

export type ResolvedSubjectInput = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
	title: string;
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
			title: paper.identity.arxivId ?? paper.identity.doi ?? paper.identity.openAlexId ?? 'Paper',
			url: paper.canonicalUrl,
		};
	}
	const detected = detectResourceUrl(url);
	return {
		identifiers: detected
			? normalizeResourceIdentifiers([{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }])
			: [],
		normalizedUrl: url,
		title: new URL(url).hostname,
		url,
	};
}
