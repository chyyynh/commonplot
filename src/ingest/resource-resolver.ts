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
	toResourceIdentityColumns,
} from '../shared/resource-types.ts';
import type { AcquiredMaterial, ResourceForProcessing } from '../shared/types.ts';
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
		| 'normalized_url'
		| 'original_lang'
		| 'processing_id'
		| 'published_date'
		| 'scope'
		| 'source_id'
		| 'storage_key'
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
): ResourceForProcessing {
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
		...toResourceIdentityColumns(identity),
		processing_id: origin.processing_id,
		source_id: origin.source_id,
		scope: origin.scope,
		original_lang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeResourceLang(origin.original_lang),
		title: acquired.title.trim(),
		summary: acquired.summary ?? origin.summary,
		content: acquired.markdown,
		url,
		source: acquired.source,
		published_date: resolution.publishedDate,
		tags: origin.tags,
		keywords: origin.keywords,
		creators: acquired.creators,
		kind_metadata: acquired.kindMetadata,
		source_revision: acquired.sourceSnapshotHash,
		resource_identifiers: identifiers,
		storage_key: origin.scope === 'private' ? origin.storage_key : null,
		file_type: acquired.fileType,
		normalized_url: url ?? origin.normalized_url,
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
