import { z } from 'zod';
import { isPaperIdentifierScheme, normalizePaperIdentifiers, type PaperIdentifier, type PaperIdentifierScheme } from './paper-identity.ts';
import { parseExternalHttpUrl } from './url.ts';

export const RESOURCE_TYPES = {
	kinds: z.enum(['blog', 'forum', 'post', 'video', 'paper', 'image', 'file']),
	platformKinds: {
		hackernews: 'forum',
		lesswrong: 'blog',
		twitter: 'post',
		youtube: 'video',
	},
} as const;

export type ResourceKind = z.infer<typeof RESOURCE_TYPES.kinds>;

export type ContentResourceKind = Exclude<ResourceKind, 'image' | 'file'>;

export type ResourcePlatform = keyof typeof RESOURCE_TYPES.platformKinds | null;

export type ResourceIdentity = Readonly<{
	kind: ResourceKind;
	resourcePlatform: ResourcePlatform;
}>;

export type ContentResourceIdentity = Readonly<{
	kind: ContentResourceKind;
	resourcePlatform: ResourcePlatform;
}>;

export function isContentResourceKind(value: unknown): value is ContentResourceKind {
	const kind = RESOURCE_TYPES.kinds.safeParse(value);
	return kind.success && kind.data !== 'image' && kind.data !== 'file';
}

function isResourcePlatform(value: unknown): value is ResourcePlatform {
	return value === null || (typeof value === 'string' && Object.hasOwn(RESOURCE_TYPES.platformKinds, value));
}

export function parseResourceIdentity(kind: unknown, resourcePlatform: unknown): ResourceIdentity | null {
	const parsedKind = RESOURCE_TYPES.kinds.safeParse(kind);
	if (!parsedKind.success || !isResourcePlatform(resourcePlatform)) return null;
	const resourceKind = parsedKind.data;
	if (resourcePlatform !== null && RESOURCE_TYPES.platformKinds[resourcePlatform] !== resourceKind) return null;
	return { kind: resourceKind, resourcePlatform };
}

export function isContentResourceIdentity(identity: ResourceIdentity): identity is ContentResourceIdentity {
	return isContentResourceKind(identity.kind);
}

export function parseResourceProviderSequence(value: unknown): bigint | null {
	if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return null;
	const sequence = BigInt(value);
	return sequence <= 9_223_372_036_854_775_807n ? sequence : null;
}

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

const ResourceMediaAttachmentSchema = z.object({
	kind: z.enum(['image', 'video', 'animated']),
	url: optionalHttpUrl,
	videoUrl: optionalHttpUrl.optional(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});

export type ResourceMediaAttachment = Readonly<z.infer<typeof ResourceMediaAttachmentSchema>>;

const PostQuoteSchema = z.object({ creator: ResourceCreatorSchema, text: z.string().trim().min(1) });
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
export type PaperRelationItem = Readonly<z.infer<typeof PaperRelationItemSchema>>;
export type PaperRelationSnapshot = Readonly<z.infer<typeof PaperRelationSnapshotSchema>>;

const ResourceKindMetadataSchemas = {
	blog: z.object({ siteName: z.string().trim().min(1).optional() }).nullable(),
	forum: z.object({
		itemType: z.enum(['story', 'ask', 'show', 'job']).optional(),
		points: z.number().int().nonnegative().optional(),
		commentCount: z.number().int().nonnegative().optional(),
	}),
	post: z.object({ attachments: z.array(ResourceMediaAttachmentSchema).max(16), quote: PostQuoteSchema.optional() }),
	video: z.object({
		durationSeconds: z.number().int().positive().optional(),
		viewCount: z.number().int().nonnegative().optional(),
		likeCount: z.number().int().nonnegative().optional(),
		commentCount: z.number().int().nonnegative().optional(),
	}),
	paper: z.object({
		venue: z.string().trim().min(1).optional(),
		year: z.number().int().positive().optional(),
		citedByCount: z.number().int().nonnegative().optional(),
		referenceCount: z.number().int().nonnegative().optional(),
		pdfUrl: optionalHttpUrl.optional(),
		references: PaperRelationSnapshotSchema.optional(),
		citations: PaperRelationSnapshotSchema.optional(),
	}),
	image: z.null(),
	file: z.null(),
} as const satisfies Readonly<Record<ResourceKind, z.ZodType>>;

export type ResourceKindMetadataByKind = Readonly<{
	[K in ResourceKind]: z.infer<(typeof ResourceKindMetadataSchemas)[K]>;
}>;

export type ForumKindMetadata = ResourceKindMetadataByKind['forum'];
export type PostKindMetadata = ResourceKindMetadataByKind['post'];
export type PaperKindMetadata = ResourceKindMetadataByKind['paper'];

export type ResourceKindMetadata = ResourceKindMetadataByKind[keyof ResourceKindMetadataByKind];

export const ResourceCreatorsSchema = z.array(ResourceCreatorSchema);

export function parseStoredResourceKindMetadata(kind: ResourceKind, value: unknown): ResourceKindMetadata | null {
	return ResourceKindMetadataSchemas[kind].parse(value);
}

type PlatformResourceIdentifierScheme = Exclude<ResourcePlatform, null>;

export type ResourceIdentifierScheme = PaperIdentifierScheme | PlatformResourceIdentifierScheme;

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
