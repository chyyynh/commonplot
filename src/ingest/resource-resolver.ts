import { type PaperIdentifier, paperIdentifiersFromIdentity, resolveExactPaperInput } from '../shared/paper-identity.ts';
import {
	isResourceIdentifierCompatibleWithIdentity,
	normalizeResourceIdentifiers,
	type PlatformResourceIdentifierScheme,
	type ResourceIdentifier,
} from '../shared/resource-identifiers.ts';
import {
	type ContentResourceIdentity,
	type ResourcePlatform,
	resourceIdentityForDetectedPlatform,
	type SourceAcquisitionMode,
} from '../shared/resource-types.ts';
import { detectResourceUrl, normalizeUrl } from '../shared/url.ts';

const PDF_MIME = 'application/pdf';

export type ResourceAdmissionOrigin =
	| Readonly<{ type: 'saved-url' }>
	| Readonly<{ type: 'upload'; storageKey: string; mimeType: string }>
	| Readonly<{
			type: 'monitored-source';
			sourceId: string;
			acquisitionMode: SourceAcquisitionMode;
	  }>;

export type ResolutionEvidence =
	| Readonly<{ type: 'url-pattern'; pattern: 'hackernews' | 'twitter' | 'youtube' }>
	| Readonly<{ type: 'platform-identifier'; scheme: PlatformResourceIdentifierScheme }>
	| Readonly<{ type: 'identifier'; schemes: PaperIdentifier['scheme'][] }>
	| Readonly<{ type: 'mime'; mimeType: string }>
	| Readonly<{ type: 'translator'; itemType: string; schemes: PaperIdentifier['scheme'][] }>
	| Readonly<{ type: 'openalex'; openAlexId: string }>;

type ResolvedBase<K extends ContentResourceIdentity['kind']> = Readonly<{
	kind: K;
	evidence: ResolutionEvidence[];
}>;

export type ResolvedContentResourceInput =
	| (ResolvedBase<'blog'> &
			Readonly<{
				resourcePlatform: null;
				acquisition: 'web' | 'feed' | 'pdf';
			}>)
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
				acquisition: 'openalex-pdf' | 'openalex-grobid' | 'uploaded-pdf' | 'publisher-page' | 'metadata-only';
			}>);

type ResolveContentResourceInput = Readonly<{
	url: string | null;
	storageKey: string | null;
	fileType: string | null;
	sourceId: string | null;
	sourceAcquisitionMode: SourceAcquisitionMode | null;
	paperIdentifiers: PaperIdentifier[];
	resourceIdentifiers: ResourceIdentifier[];
	openAlexId: string | null;
	openAlexContent: 'pdf' | 'grobid' | null;
	translatorEvidence?: { itemType: string; schemes: PaperIdentifier['scheme'][] };
	subjectUrl?: string | null;
}>;

export function resourceAdmissionOrigin(input: {
	fileType: string | null;
	sourceAcquisitionMode: SourceAcquisitionMode | null;
	sourceId: string | null;
	storageKey: string | null;
}): ResourceAdmissionOrigin {
	if (input.storageKey) {
		if (!input.fileType) throw new Error('Uploaded resource is missing its MIME type');
		return { type: 'upload', storageKey: input.storageKey, mimeType: input.fileType };
	}
	if (input.sourceId) {
		if (!input.sourceAcquisitionMode) throw new Error('Monitored resource is missing its acquisition mode');
		return {
			type: 'monitored-source',
			sourceId: input.sourceId,
			acquisitionMode: input.sourceAcquisitionMode,
		};
	}
	return { type: 'saved-url' };
}

export type ExactPlatformLocator = Readonly<{
	resourcePlatform: PlatformResourceIdentifierScheme;
	platformId: string;
}>;

export function exactPlatformLocator(identifiers: readonly ResourceIdentifier[]): ExactPlatformLocator | null {
	const platformIdentifiers = normalizeResourceIdentifiers(identifiers).filter(
		(identifier): identifier is ResourceIdentifier & { scheme: PlatformResourceIdentifierScheme } =>
			identifier.scheme === 'hackernews' || identifier.scheme === 'twitter' || identifier.scheme === 'youtube',
	);
	const locators = new Map(platformIdentifiers.map((identifier) => [identifier.scheme, identifier.value]));
	if (locators.size > 1) throw new Error('Resource has conflicting exact platform identifiers');
	const [locator] = locators;
	return locator ? { resourcePlatform: locator[0], platformId: locator[1] } : null;
}

export function canonicalPlatformUrl(locator: ExactPlatformLocator): string {
	switch (locator.resourcePlatform) {
		case 'hackernews':
			return `https://news.ycombinator.com/item?id=${locator.platformId}`;
		case 'twitter':
			return `https://x.com/i/status/${locator.platformId}`;
		case 'youtube':
			return `https://www.youtube.com/watch?v=${locator.platformId}`;
	}
}

function acquisitionForPaper(input: ResolveContentResourceInput, origin: ResourceAdmissionOrigin) {
	if (origin.type === 'upload') return 'uploaded-pdf' as const;
	if (input.openAlexContent === 'pdf') return 'openalex-pdf' as const;
	if (input.openAlexContent === 'grobid') return 'openalex-grobid' as const;
	if (input.url) return 'publisher-page' as const;
	return 'metadata-only' as const;
}

function genericBlogAcquisition(input: ResolveContentResourceInput, origin: ResourceAdmissionOrigin) {
	if (input.fileType === PDF_MIME) return 'pdf' as const;
	if (origin.type === 'monitored-source' && origin.acquisitionMode === 'feed') return 'feed' as const;
	return 'web' as const;
}

function resolvedPlatformInput(
	platform: Exclude<ResourcePlatform, null>,
	locator: ExactPlatformLocator,
	input: ResolveContentResourceInput,
	evidence: ResolutionEvidence[],
): ResolvedContentResourceInput {
	if (locator.resourcePlatform !== platform) {
		throw new Error(`${platform} resource is missing an exact URL locator`);
	}
	switch (platform) {
		case 'hackernews':
			return {
				kind: 'forum',
				resourcePlatform: platform,
				locator: { itemId: locator.platformId },
				subjectUrl: input.subjectUrl?.trim() || null,
				evidence,
			};
		case 'twitter':
			return {
				kind: 'post',
				resourcePlatform: platform,
				locator: { tweetId: locator.platformId },
				subjectUrl: input.subjectUrl?.trim() || null,
				evidence,
			};
		case 'youtube':
			return {
				kind: 'video',
				resourcePlatform: platform,
				locator: { videoId: locator.platformId },
				evidence,
			};
	}
}

export function resolveContentResource(input: ResolveContentResourceInput): ResolvedContentResourceInput {
	const origin = resourceAdmissionOrigin({
		fileType: input.fileType,
		sourceAcquisitionMode: input.sourceAcquisitionMode,
		sourceId: input.sourceId,
		storageKey: input.storageKey,
	});
	const detected = input.url ? detectResourceUrl(input.url) : null;
	const storedLocator = exactPlatformLocator(input.resourceIdentifiers);
	const evidence: ResolutionEvidence[] = [];
	if (input.fileType) evidence.push({ type: 'mime', mimeType: input.fileType });
	if (input.paperIdentifiers.length) {
		evidence.push({ type: 'identifier', schemes: [...new Set(input.paperIdentifiers.map(({ scheme }) => scheme))] });
	}
	if (input.translatorEvidence) evidence.push({ type: 'translator', ...input.translatorEvidence });
	if (input.openAlexId) evidence.push({ type: 'openalex', openAlexId: input.openAlexId });

	if (detected) evidence.push({ type: 'url-pattern', pattern: detected.resourcePlatform });
	if (storedLocator) evidence.push({ type: 'platform-identifier', scheme: storedLocator.resourcePlatform });
	if (
		detected &&
		storedLocator &&
		(detected.resourcePlatform !== storedLocator.resourcePlatform || detected.platformId !== storedLocator.platformId)
	) {
		throw new Error('Resource URL conflicts with its exact platform identifier');
	}

	const locator = detected ?? storedLocator;
	if (locator) return resolvedPlatformInput(locator.resourcePlatform, locator, input, evidence);

	if (input.paperIdentifiers.length > 0 && input.openAlexId) {
		return {
			kind: 'paper',
			resourcePlatform: null,
			identifiers: input.paperIdentifiers,
			acquisition: acquisitionForPaper(input, origin),
			evidence,
		};
	}

	return {
		kind: 'blog',
		resourcePlatform: null,
		acquisition: genericBlogAcquisition(input, origin),
		evidence,
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
			: resolution.kind === 'forum'
				? [{ preferred: true, scheme: 'hackernews', value: resolution.locator.itemId }]
				: resolution.kind === 'post'
					? [{ preferred: true, scheme: 'twitter', value: resolution.locator.tweetId }]
					: resolution.kind === 'video'
						? [{ preferred: true, scheme: 'youtube', value: resolution.locator.videoId }]
						: [];
	return normalizeResourceIdentifiers([...resolved, ...compatibleCurrent.map((identifier) => ({ ...identifier, preferred: false }))]);
}

export type ResolvedSubjectInput = Readonly<{
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
