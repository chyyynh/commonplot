import { z } from 'zod';
import {
	isPaperIdentifierScheme,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	PAPER_IDENTIFIER_SCHEMES,
	type PaperIdentifier,
} from './paper-identity.ts';

const resourceKinds = z.enum(['blog', 'forum', 'post', 'video', 'paper', 'image', 'file']);
const platformKinds = {
	hackernews: 'forum',
	lesswrong: 'blog',
	twitter: 'post',
	youtube: 'video',
} as const;
const resourcePlatforms = z.enum(Object.keys(platformKinds) as [keyof typeof platformKinds, ...(keyof typeof platformKinds)[]]);

export const RESOURCE_TYPES = {
	kinds: resourceKinds,
	platformKinds,
	platforms: resourcePlatforms,
	identity: z
		.object({ kind: resourceKinds, resourcePlatform: resourcePlatforms.nullable() })
		.refine(({ kind, resourcePlatform }) => resourcePlatform === null || platformKinds[resourcePlatform] === kind),
} as const;

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
const optionalHttpUrl = z.url({ protocol: /^https?$/ }).refine((value) => {
	const url = URL.parse(value);
	return url !== null && !url.username && !url.password;
});
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
} as const satisfies Readonly<Record<(typeof RESOURCE_TYPES.kinds.options)[number], z.ZodType>>;

export type ResourceKindMetadataByKind = Readonly<{
	[K in (typeof RESOURCE_TYPES.kinds.options)[number]]: z.infer<(typeof ResourceKindMetadataSchemas)[K]>;
}>;

export type ForumKindMetadata = ResourceKindMetadataByKind['forum'];
export type PostKindMetadata = ResourceKindMetadataByKind['post'];
export type PaperKindMetadata = ResourceKindMetadataByKind['paper'];

export type ResourceKindMetadata = ResourceKindMetadataByKind[keyof ResourceKindMetadataByKind];

export const ResourceCreatorsSchema = z.array(ResourceCreatorSchema);

export function parseStoredResourceKindMetadata(
	kind: (typeof RESOURCE_TYPES.kinds.options)[number],
	value: unknown,
): ResourceKindMetadata | null {
	return ResourceKindMetadataSchemas[kind].parse(value);
}

const ResourceIdentifierSchemeSchema = z.enum([...PAPER_IDENTIFIER_SCHEMES, ...RESOURCE_TYPES.platforms.options]);

export type ResourceIdentifierScheme = z.infer<typeof ResourceIdentifierSchemeSchema>;

function canonicalIdentifierValue(scheme: ResourceIdentifierScheme, value: string): string | null {
	switch (scheme) {
		case 'doi':
			return normalizeDoi(value);
		case 'arxiv':
			return normalizeArxivId(value);
		case 'openalex':
			return normalizeOpenAlexId(value);
		case 'hackernews':
			return /^[1-9]\d*$/.test(value) ? value : null;
		case 'lesswrong':
			return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
		case 'twitter':
			return /^\d+$/.test(value) ? value : null;
		case 'youtube':
			return /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
	}
}

const ResourceIdentifierSchema = z
	.object({ preferred: z.boolean(), scheme: ResourceIdentifierSchemeSchema, value: z.string() })
	.strict()
	.refine(
		(identifier) => canonicalIdentifierValue(identifier.scheme, identifier.value) === identifier.value,
		'Identifier is not canonical',
	);

export const ResourceIdentifiersSchema = z.array(ResourceIdentifierSchema).refine((identifiers) => {
	const values = identifiers.map(({ scheme, value }) => `${scheme}:${value}`);
	const schemes = identifiers.map(({ scheme }) => scheme);
	const preferredSchemes = identifiers.filter(({ preferred }) => preferred).map(({ scheme }) => scheme);
	return (
		new Set(values).size === values.length &&
		new Set(preferredSchemes).size === preferredSchemes.length &&
		new Set(preferredSchemes).size === new Set(schemes).size
	);
}, 'Identifiers must be unique with exactly one preferred value per scheme');

export type ResourceIdentifier = Readonly<z.infer<typeof ResourceIdentifierSchema>>;

export function isPaperIdentifier(identifier: ResourceIdentifier): identifier is PaperIdentifier {
	return isPaperIdentifierScheme(identifier.scheme);
}
