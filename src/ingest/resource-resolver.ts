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
	type ResourceScope,
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
	origin: {
		keywords: string[];
		normalizedUrl: string | null;
		originalLang: string;
		processingId: string;
		publishedDate: string | null;
		scope: ResourceScope;
		sourceId: string | null;
		storageKey: string | null;
		summary: string | null;
		tags: string[];
		url: string | null;
	},
	resourceIdentifiers: readonly ResourceIdentifier[],
): ResourceForProcessing {
	const canonicalUrl = acquired.canonicalUrl?.trim() || origin.url;
	const detected = canonicalUrl ? detectResourceUrl(canonicalUrl) : null;
	const paperIdentifiers = resourceIdentifiers.filter(isPaperIdentifier);
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
	const url = detected ? canonicalResourcePlatformUrl(detected.resourcePlatform, detected.platformId) : canonicalUrl;
	let publishedDate = origin.publishedDate;
	if (publishedDate === null && acquired.publishedDate?.trim()) {
		const parsed = new Date(acquired.publishedDate);
		if (!Number.isNaN(parsed.getTime())) publishedDate = parsed.toISOString();
	}
	return {
		...toResourceIdentityColumns(identity),
		processing_id: origin.processingId,
		source_id: origin.sourceId,
		scope: origin.scope,
		original_lang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeResourceLang(origin.originalLang),
		title: acquired.title.trim(),
		summary: acquired.summary ?? origin.summary,
		content: acquired.markdown,
		url,
		source: acquired.source,
		published_date: publishedDate,
		tags: origin.tags,
		keywords: origin.keywords,
		creators: acquired.creators,
		kind_metadata: acquired.kindMetadata,
		source_revision: acquired.sourceSnapshotHash,
		resource_identifiers: identifiers,
		storage_key: origin.scope === 'private' ? origin.storageKey : null,
		file_type: acquired.fileType,
		normalized_url: url ?? origin.normalizedUrl,
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
