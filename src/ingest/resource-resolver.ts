import { type PaperIdentifier, paperIdentifiersFromIdentity, resolveExactPaperInput } from '../shared/paper-identity.ts';
import {
	isPaperIdentifier,
	isResourceIdentifierCompatibleWithIdentity,
	normalizeResourceIdentifiers,
	type PlatformResourceIdentifierScheme,
	type ResourceIdentifier,
} from '../shared/resource-identifiers.ts';
import { type ContentResourceIdentity, type ResourcePlatform, resourceIdentityForDetectedPlatform } from '../shared/resource-types.ts';
import { detectResourceUrl, normalizeUrl } from '../shared/url.ts';

type ResolvedBase<K extends ContentResourceIdentity['kind']> = Readonly<{
	kind: K;
}>;

export type ResolvedContentResourceInput =
	| (ResolvedBase<'blog'> & Readonly<{ resourcePlatform: null } | { resourcePlatform: 'lesswrong'; locator: { postId: string } }>)
	| (ResolvedBase<'forum'> &
			Readonly<{
				resourcePlatform: 'hackernews';
				locator: { itemId: string };
				subjectUrl: string | null;
			}>)
	| (ResolvedBase<'post'> &
			Readonly<{
				resourcePlatform: 'twitter';
				locator: { tweetId: string };
				subjectUrl: string | null;
			}>)
	| (ResolvedBase<'video'> &
			Readonly<{
				resourcePlatform: 'youtube';
				locator: { videoId: string };
			}>)
	| (ResolvedBase<'paper'> &
			Readonly<{
				resourcePlatform: null;
				identifiers: PaperIdentifier[];
			}>);

type ResolveContentResourceInput = Readonly<{
	url: string | null;
	resourceIdentifiers: ResourceIdentifier[];
	subjectUrl?: string | null;
}>;

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

function resolvedPlatformInput(
	platform: Exclude<ResourcePlatform, null>,
	locator: ExactPlatformLocator,
	input: ResolveContentResourceInput,
): ResolvedContentResourceInput {
	if (locator.resourcePlatform !== platform) {
		throw new Error(`${platform} resource is missing an exact URL locator`);
	}
	switch (platform) {
		case 'lesswrong':
			return {
				kind: 'blog',
				resourcePlatform: platform,
				locator: { postId: locator.platformId },
			};
		case 'hackernews':
			return {
				kind: 'forum',
				resourcePlatform: platform,
				locator: { itemId: locator.platformId },
				subjectUrl: input.subjectUrl?.trim() || null,
			};
		case 'twitter':
			return {
				kind: 'post',
				resourcePlatform: platform,
				locator: { tweetId: locator.platformId },
				subjectUrl: input.subjectUrl?.trim() || null,
			};
		case 'youtube':
			return {
				kind: 'video',
				resourcePlatform: platform,
				locator: { videoId: locator.platformId },
			};
	}
}

export function resolveContentResource(input: ResolveContentResourceInput): ResolvedContentResourceInput {
	const detected = input.url ? detectResourceUrl(input.url) : null;
	const storedLocator = exactPlatformLocator(input.resourceIdentifiers);
	const paperIdentifiers = input.resourceIdentifiers.filter(isPaperIdentifier);
	if (
		detected &&
		storedLocator &&
		(detected.resourcePlatform !== storedLocator.resourcePlatform || detected.platformId !== storedLocator.platformId)
	) {
		throw new Error('Resource URL conflicts with its exact platform identifier');
	}

	const locator = detected ?? storedLocator;
	if (locator) return resolvedPlatformInput(locator.resourcePlatform, locator, input);

	if (paperIdentifiers.some((identifier) => identifier.scheme === 'openalex')) {
		return {
			kind: 'paper',
			resourcePlatform: null,
			identifiers: paperIdentifiers,
		};
	}

	return {
		kind: 'blog',
		resourcePlatform: null,
	};
}

export function resolvedResourceIdentifiers(
	resolution: ResolvedContentResourceInput,
	current: readonly ResourceIdentifier[] = [],
): ResourceIdentifier[] {
	const compatibleCurrent = current.filter((identifier) => isResourceIdentifierCompatibleWithIdentity(identifier, resolution));
	const resolved: ResourceIdentifier[] =
		resolution.kind === 'paper'
			? resolution.identifiers
			: resolution.kind === 'blog' && resolution.resourcePlatform === 'lesswrong'
				? [{ preferred: true, scheme: 'lesswrong', value: resolution.locator.postId }]
				: resolution.kind === 'forum'
					? [{ preferred: true, scheme: 'hackernews', value: resolution.locator.itemId }]
					: resolution.kind === 'post'
						? [{ preferred: true, scheme: 'twitter', value: resolution.locator.tweetId }]
						: resolution.kind === 'video'
							? [{ preferred: true, scheme: 'youtube', value: resolution.locator.videoId }]
							: [];
	return normalizeResourceIdentifiers([...resolved, ...compatibleCurrent.map((identifier) => ({ ...identifier, preferred: false }))]);
}

type ResolvedSubjectInput = Readonly<{
	identity: ContentResourceIdentity;
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
	title: string;
	url: string;
}>;

export function resolvedSubjectInput(resolution: ResolvedContentResourceInput): ResolvedSubjectInput | null {
	const subjectUrl = resolution.kind === 'forum' || resolution.kind === 'post' ? resolution.subjectUrl : null;
	if (!subjectUrl) return null;
	const url = normalizeUrl(subjectUrl);
	const paper = resolveExactPaperInput(url);
	if (paper) {
		return {
			identity: { kind: 'paper', resourcePlatform: null },
			identifiers: paperIdentifiersFromIdentity(paper.identity),
			normalizedUrl: paper.canonicalUrl,
			title: paper.identity.arxivId ?? paper.identity.doi ?? paper.identity.openAlexId ?? 'Paper',
			url: paper.canonicalUrl,
		};
	}
	const detected = detectResourceUrl(url);
	if (detected) {
		const identity = resourceIdentityForDetectedPlatform(detected.resourcePlatform);
		return {
			identity,
			identifiers: normalizeResourceIdentifiers([{ preferred: true, scheme: detected.resourcePlatform, value: detected.platformId }]),
			normalizedUrl: url,
			title: new URL(url).hostname,
			url,
		};
	}
	return {
		identity: { kind: 'blog', resourcePlatform: null },
		identifiers: [],
		normalizedUrl: url,
		title: new URL(url).hostname,
		url,
	};
}
