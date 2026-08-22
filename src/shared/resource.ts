import { z } from 'zod';
import { isPaperIdentifierScheme, normalizePaperIdentifiers, type PaperIdentifier, type PaperIdentifierScheme } from './paper-identity.ts';
import { parseExternalHttpUrl } from './url.ts';

export const RESOURCE_KINDS = ['blog', 'forum', 'post', 'video', 'paper', 'image', 'file'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const CONTENT_RESOURCE_KINDS = ['blog', 'forum', 'post', 'video', 'paper'] as const satisfies readonly ResourceKind[];

export type ContentResourceKind = (typeof CONTENT_RESOURCE_KINDS)[number];

export const TRANSLATABLE_RESOURCE_KINDS = ['blog', 'forum', 'post', 'paper'] as const satisfies readonly ResourceKind[];

export const RESOURCE_PLATFORMS = ['hackernews', 'lesswrong', 'twitter', 'youtube'] as const;

export type ResourcePlatform = (typeof RESOURCE_PLATFORMS)[number] | null;

export const VALID_KIND_PLATFORMS = {
	blog: [null, 'lesswrong'],
	forum: ['hackernews'],
	post: ['twitter'],
	video: ['youtube'],
	paper: [null],
	image: [null],
	file: [null],
} as const satisfies Readonly<Record<ResourceKind, readonly ResourcePlatform[]>>;

export type ResourceIdentity = {
	[K in ResourceKind]: Readonly<{
		kind: K;
		resourcePlatform: (typeof VALID_KIND_PLATFORMS)[K][number];
	}>;
}[ResourceKind];

export type ContentResourceIdentity = Extract<ResourceIdentity, { kind: ContentResourceKind }>;

const DETECTED_PLATFORM_RESOURCE_IDENTITIES = {
	hackernews: { kind: 'forum', resourcePlatform: 'hackernews' },
	lesswrong: { kind: 'blog', resourcePlatform: 'lesswrong' },
	twitter: { kind: 'post', resourcePlatform: 'twitter' },
	youtube: { kind: 'video', resourcePlatform: 'youtube' },
} as const satisfies Readonly<Record<Exclude<ResourcePlatform, null>, ContentResourceIdentity>>;

export const RESOURCE_KIND_DISPLAY_LABELS = {
	blog: 'Blog',
	forum: 'Forum',
	post: 'Post',
	video: 'Video',
	paper: 'Paper',
	image: 'Image',
	file: 'File',
} as const satisfies Readonly<Record<ResourceKind, string>>;

export const RESOURCE_PLATFORM_DISPLAY_LABELS = {
	hackernews: 'Hacker News',
	lesswrong: 'LessWrong',
	twitter: 'Twitter',
	youtube: 'YouTube',
} as const satisfies Readonly<Record<Exclude<ResourcePlatform, null>, string>>;

export function isContentResourceKind(value: unknown): value is ContentResourceKind {
	return typeof value === 'string' && (CONTENT_RESOURCE_KINDS as readonly string[]).includes(value);
}

export function isResourcePlatform(value: unknown): value is ResourcePlatform {
	return value === null || (typeof value === 'string' && (RESOURCE_PLATFORMS as readonly string[]).includes(value));
}

export function parseResourceIdentity(kind: unknown, resourcePlatform: unknown): ResourceIdentity | null {
	if (typeof kind !== 'string' || !(RESOURCE_KINDS as readonly string[]).includes(kind) || !isResourcePlatform(resourcePlatform)) {
		return null;
	}
	const resourceKind = kind as ResourceKind;
	const validPlatforms: readonly ResourcePlatform[] = VALID_KIND_PLATFORMS[resourceKind];
	return validPlatforms.includes(resourcePlatform) ? ({ kind: resourceKind, resourcePlatform } as ResourceIdentity) : null;
}

export function isContentResourceIdentity(identity: ResourceIdentity): identity is ContentResourceIdentity {
	return isContentResourceKind(identity.kind);
}

export function parseResourceProviderSequence(value: unknown): bigint | null {
	if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return null;
	const sequence = BigInt(value);
	return sequence <= 9_223_372_036_854_775_807n ? sequence : null;
}

export function resourceIdentityForDetectedPlatform(resourcePlatform: Exclude<ResourcePlatform, null>): ContentResourceIdentity {
	return DETECTED_PLATFORM_RESOURCE_IDENTITIES[resourcePlatform];
}

export type ResourceContentSurface = 'app' | 'ai-tools' | 'export';

export function hasResourceContentAccess(input: { surface: ResourceContentSurface; scope: string; viewerHasOwnership: boolean }): boolean {
	return (input.scope === 'corpus' && input.surface === 'app') || input.viewerHasOwnership;
}

export const DEFAULT_RESOURCE_LANG = 'en';

export const ZH_HANT_RESOURCE_LANG = 'zh-Hant';

const RESOURCE_LANG_MAX_LENGTH = 35;

export function canonicalizeResourceLang(value: unknown): string {
	if (typeof value !== 'string') throw new Error(`Invalid resource language: ${String(value)}`);
	const lang = value.trim();
	if (!lang || lang.length > RESOURCE_LANG_MAX_LENGTH) throw new Error(`Invalid resource language: ${value}`);
	try {
		const canonical = Intl.getCanonicalLocales(lang)[0];
		if (!canonical || canonical.length > RESOURCE_LANG_MAX_LENGTH) throw new Error('Invalid locale');
		return canonical;
	} catch {
		throw new Error(`Invalid resource language: ${value}`);
	}
}

export function canonicalizeOptionalResourceLang(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const lang = value.trim().replaceAll('_', '-');
	if (!lang || lang.toLowerCase() === 'und') return null;
	try {
		return canonicalizeResourceLang(lang);
	} catch {
		return null;
	}
}

export function selectPreferredResourceTranslation<T extends { lang: string }>(
	translations: readonly T[],
	requestedLocale: string | null | undefined,
	originalLang: string | null | undefined,
): T | null {
	const byLocale = new Map<string, T>();
	for (const translation of translations) {
		const locale = canonicalizeOptionalResourceLang(translation.lang);
		if (locale && !byLocale.has(locale)) byLocale.set(locale, translation);
	}
	const requested = canonicalizeOptionalResourceLang(requestedLocale);
	const original = canonicalizeOptionalResourceLang(originalLang);
	return (requested ? byLocale.get(requested) : null) ?? (original ? byLocale.get(original) : null) ?? null;
}

export const RESOURCE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;

export type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];

const RESOURCE_CREATOR_ROLES = ['author', 'editor', 'submitter', 'channel'] as const;
const optionalHttpUrl = z.url().refine((value) => parseExternalHttpUrl(value) !== null);
const ResourceCreatorSchema = z
	.object({
		role: z.enum(RESOURCE_CREATOR_ROLES),
		given: z.string().trim().min(1).optional(),
		family: z.string().trim().min(1).optional(),
		literal: z.string().trim().min(1).optional(),
		handle: z.string().trim().min(1).optional(),
		avatarUrl: optionalHttpUrl.optional(),
		profileUrl: optionalHttpUrl.optional(),
		verified: z.boolean().optional(),
	})
	.refine((creator) => creator.given || creator.family || creator.literal, 'Creator must have a name');

export type ResourceCreator = Readonly<z.infer<typeof ResourceCreatorSchema>>;

export function resourceCreatorName(creator: ResourceCreator | undefined): string | null {
	return creator?.literal ?? ([creator?.given, creator?.family].filter(Boolean).join(' ') || null);
}

export function literalCreator(
	role: ResourceCreator['role'],
	literal: string | null | undefined,
	extra: Omit<ResourceCreator, 'literal' | 'role'> = {},
): ResourceCreator[] {
	const name = literal?.trim();
	return name ? [{ role, literal: name, ...extra }] : [];
}

const ResourceMediaAttachmentSchema = z.object({
	kind: z.enum(['image', 'video', 'animated']),
	url: optionalHttpUrl,
	videoUrl: optionalHttpUrl.optional(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});

export type ResourceMediaAttachment = Readonly<z.infer<typeof ResourceMediaAttachmentSchema>>;

const BlogKindMetadataSchema = z.object({ siteName: z.string().trim().min(1).optional() });
const ForumKindMetadataSchema = z.object({
	itemType: z.enum(['story', 'ask', 'show', 'job']).optional(),
	points: z.number().int().nonnegative().optional(),
	commentCount: z.number().int().nonnegative().optional(),
});
const PostQuoteSchema = z.object({ creator: ResourceCreatorSchema, text: z.string().trim().min(1) });
const PostKindMetadataSchema = z.object({ attachments: z.array(ResourceMediaAttachmentSchema).max(16), quote: PostQuoteSchema.optional() });
const VideoKindMetadataSchema = z.object({
	durationSeconds: z.number().int().positive().optional(),
	viewCount: z.number().int().nonnegative().optional(),
	likeCount: z.number().int().nonnegative().optional(),
	commentCount: z.number().int().nonnegative().optional(),
});
const PaperRelationItemSchema = z.object({
	openAlexId: z.string().regex(/^W\d+$/),
	doi: z.string().trim().min(1).optional(),
	title: z.string().trim().min(1),
	authors: z.array(z.string().trim().min(1)),
	venue: z.string().trim().min(1).optional(),
	year: z.number().int().positive().optional(),
	citedByCount: z.number().int().nonnegative().optional(),
});
const PaperRelationSnapshotSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(PaperRelationItemSchema) });
const PaperKindMetadataSchema = z.object({
	venue: z.string().trim().min(1).optional(),
	year: z.number().int().positive().optional(),
	citedByCount: z.number().int().nonnegative().optional(),
	referenceCount: z.number().int().nonnegative().optional(),
	pdfUrl: optionalHttpUrl.optional(),
	references: PaperRelationSnapshotSchema.optional(),
	citations: PaperRelationSnapshotSchema.optional(),
});

type BlogKindMetadata = Readonly<z.infer<typeof BlogKindMetadataSchema>>;
export type ForumKindMetadata = Readonly<z.infer<typeof ForumKindMetadataSchema>>;
export type PostKindMetadata = Readonly<z.infer<typeof PostKindMetadataSchema>>;
type VideoKindMetadata = Readonly<z.infer<typeof VideoKindMetadataSchema>>;
export type PaperRelationItem = Readonly<z.infer<typeof PaperRelationItemSchema>>;
export type PaperRelationSnapshot = Readonly<z.infer<typeof PaperRelationSnapshotSchema>>;
export type PaperKindMetadata = Readonly<z.infer<typeof PaperKindMetadataSchema>>;

export type ResourceKindMetadataByKind = Readonly<{
	blog: BlogKindMetadata | null;
	forum: ForumKindMetadata;
	post: PostKindMetadata;
	video: VideoKindMetadata;
	paper: PaperKindMetadata;
}>;

export type ResourceKindMetadata = ResourceKindMetadataByKind[keyof ResourceKindMetadataByKind];

export function parseResourceCreators(value: unknown): ResourceCreator[] {
	return z.array(ResourceCreatorSchema).parse(value);
}

export function parseStoredResourceKindMetadata(kind: ResourceKind, value: unknown): ResourceKindMetadata | null {
	switch (kind) {
		case 'blog':
			return value === null ? null : BlogKindMetadataSchema.parse(value);
		case 'forum':
			return ForumKindMetadataSchema.parse(value);
		case 'post':
			return PostKindMetadataSchema.parse(value);
		case 'video':
			return VideoKindMetadataSchema.parse(value);
		case 'paper':
			return PaperKindMetadataSchema.parse(value);
		case 'image':
		case 'file':
			if (value !== null) throw new Error(`${kind} resources cannot have kind metadata`);
			return null;
	}
}

type PlatformResourceIdentifierScheme = Exclude<ResourcePlatform, null>;

export type ResourceIdentifierScheme = PaperIdentifierScheme | PlatformResourceIdentifierScheme;

export function isResourceIdentifierScheme(value: unknown): value is ResourceIdentifierScheme {
	return isPaperIdentifierScheme(value) || (typeof value === 'string' && (RESOURCE_PLATFORMS as readonly string[]).includes(value));
}

export type ResourceIdentifier = Readonly<{
	preferred: boolean;
	scheme: ResourceIdentifierScheme;
	value: string;
}>;

export function isPaperIdentifier(identifier: ResourceIdentifier): identifier is PaperIdentifier {
	return isPaperIdentifierScheme(identifier.scheme);
}

function normalizePlatformIdentifier(
	identifier: Omit<ResourceIdentifier, 'preferred'> & { preferred?: boolean },
): ResourceIdentifier | null {
	const value = identifier.value.trim();
	if (!value) return null;
	if (identifier.scheme === 'hackernews' && !/^[1-9]\d*$/.test(value)) return null;
	if (identifier.scheme === 'lesswrong' && !/^[A-Za-z0-9_-]{8,64}$/.test(value)) return null;
	if (identifier.scheme === 'twitter' && !/^\d+$/.test(value)) return null;
	if (identifier.scheme === 'youtube' && !/^[A-Za-z0-9_-]{6,20}$/.test(value)) return null;
	return { preferred: identifier.preferred !== false, scheme: identifier.scheme, value };
}

export function normalizeResourceIdentifiers(
	identifiers: readonly (Omit<ResourceIdentifier, 'preferred'> & { preferred?: boolean })[],
): ResourceIdentifier[] {
	const papers = normalizePaperIdentifiers(
		identifiers.filter((identifier): identifier is Omit<PaperIdentifier, 'preferred'> & { preferred?: boolean } =>
			isPaperIdentifierScheme(identifier.scheme),
		),
	);
	const platforms = identifiers.flatMap((identifier) => {
		if (isPaperIdentifierScheme(identifier.scheme)) return [];
		const normalized = normalizePlatformIdentifier(identifier);
		return normalized ? [normalized] : [];
	});
	const deduplicated = new Map<string, ResourceIdentifier>();
	for (const identifier of [...papers, ...platforms]) {
		const key = `${identifier.scheme}:${identifier.value}`;
		const existing = deduplicated.get(key);
		deduplicated.set(key, existing ? { ...existing, preferred: existing.preferred || identifier.preferred } : identifier);
	}
	const preferredSchemes = new Set<ResourceIdentifierScheme>();
	return [...deduplicated.values()].map((identifier) => {
		const preferred = identifier.preferred && !preferredSchemes.has(identifier.scheme);
		if (preferred) preferredSchemes.add(identifier.scheme);
		return { ...identifier, preferred };
	});
}

export type ResolvedResourceSubject = Readonly<{
	identifiers: ResourceIdentifier[];
	normalizedUrl: string;
}>;

type MaterializedResourceFields = {
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

export type MaterializedResource = ContentResourceIdentity & MaterializedResourceFields;

export const ENTITY_TYPES = ['person', 'organization', 'product', 'technology', 'event', 'location'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export type StoredResourceEntity = { k: string; n: string; cn: string | null; t: EntityType };

export interface TranscriptSegment {
	startTime: number;
	endTime: number;
	text: string;
}

export interface YouTubeChapter {
	title: string;
	startTime: number;
	endTime?: number;
}

interface YouTubeHighlight {
	title: string;
	summary: string;
	startTime: number;
	endTime: number;
}

export interface YouTubeHighlights {
	version: '1.0';
	model: string;
	highlights: YouTubeHighlight[];
	generatedAt: string;
}

export interface YouTubeTranscript {
	segments: TranscriptSegment[];
	language: string | null;
	chapters: YouTubeChapter[];
	chaptersFromDescription: boolean;
}

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

type AcquiredMaterialBase<T extends ResourcePlatform> = {
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
};

type AcquiredMaterialSpecialization<T extends ResourcePlatform> =
	T extends Exclude<ResourcePlatform, null> ? { platformId: string } : unknown;

export type AcquiredMaterial<T extends ResourcePlatform = ResourcePlatform> = T extends unknown
	? AcquiredMaterialBase<T> & AcquiredMaterialSpecialization<T>
	: never;

export type AcquiredResource =
	| (Exclude<AcquiredMaterial, AcquiredMaterial<'youtube'>> & { specialization: null })
	| (AcquiredMaterial<'youtube'> & { specialization: YouTubeResourceSpecialization });

export interface PaperMetadata {
	title?: string;
	authors: string[];
	abstract?: string;
	venue?: string;
	year?: number;
	publicationDate?: string;
	citedByCount?: number;
	referenceCount?: number;
	pdfUrl?: string;
	references?: PaperRelationSnapshot;
	citations?: PaperRelationSnapshot;
}
