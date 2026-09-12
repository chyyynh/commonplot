import { z } from 'zod';
import {
	isPaperIdentifierScheme,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	PAPER_IDENTIFIER_SCHEMES,
	type PaperIdentifier,
} from './paper-identity.ts';

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

const ResourceMediaAttachmentSchema = z.object({
	kind: z.enum(['image', 'video', 'animated']),
	url: optionalHttpUrl,
	width: z.int().positive().optional(),
	height: z.int().positive().optional(),
});

const PostQuoteSchema = z.object({ creator: ResourceCreatorSchema, text: z.string().trim().min(1) });
export const RESOURCE_KIND_METADATA = {
	blog: z.object({ siteName: z.string().trim().min(1).optional() }).nullable(),
	forum: z.object({
		points: z.int().nonnegative().optional(),
		commentCount: z.int().nonnegative().optional(),
	}),
	post: z.object({ attachments: z.array(ResourceMediaAttachmentSchema).max(16), quote: PostQuoteSchema.optional() }),
	video: z.object({
		durationSeconds: z.int().positive().optional(),
		viewCount: z.int().nonnegative().optional(),
		likeCount: z.int().nonnegative().optional(),
		commentCount: z.int().nonnegative().optional(),
	}),
	paper: z.object({
		venue: z.string().trim().min(1).optional(),
		year: z.int().positive().optional(),
		citedByCount: z.int().nonnegative().optional(),
		referenceCount: z.int().nonnegative().optional(),
		pdfUrl: optionalHttpUrl.optional(),
	}),
	image: z.null(),
	file: z.null(),
} as const;

export type ResourceKind = keyof typeof RESOURCE_KIND_METADATA;
export type PostKindMetadata = z.infer<typeof RESOURCE_KIND_METADATA.post>;
export type ResourceKindMetadata = z.infer<(typeof RESOURCE_KIND_METADATA)[ResourceKind]>;

export const RESOURCE_PLATFORMS = {
	lesswrong: { kind: 'blog', identifier: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) },
	hackernews: { kind: 'forum', identifier: z.string().regex(/^[1-9]\d*$/) },
	twitter: { kind: 'post', identifier: z.string().regex(/^\d+$/) },
	youtube: { kind: 'video', identifier: z.string().regex(/^[A-Za-z0-9_-]{11}$/) },
} as const satisfies Record<string, { kind: ResourceKind; identifier: z.ZodString }>;
export type ResourcePlatform = keyof typeof RESOURCE_PLATFORMS;
export type PlatformResourceUrl = { resourcePlatform: ResourcePlatform; platformId: string; canonicalUrl: string };

export type ResourceCitations = {
	references: readonly { key: string; label: string | null; text: string }[];
};

// Adapters share an output contract; each adapter owns its mapping and identity.
export type AcquiredResource = {
	citations?: ResourceCitations | null;
	kind: Exclude<ResourceKind, 'image'>;
	resourcePlatform: ResourcePlatform | null;
	resourceIdentifiers: ResourceIdentifier[];
	url: string | null;
	title: string;
	summary: string | null;
	content: string;
	source: string;
	originalLang: string;
	publishedDate: string | null;
	creators: ResourceCreator[];
	kindMetadata: ResourceKindMetadata;
	fileType: string | null;
	previewImageUrl: string | null;
	subject: (ResourceSubjectIdentity & { publishedDate: string | null }) | null;
};
export type ResourceSubjectIdentity = { identifiers: ResourceIdentifier[]; normalizedUrl: string };
export type ResourceAcquisitionHints = { originalLang: string | null; publishedDate: string | null; summary: string | null };

export function resolveResourceHints(acquired: ResourceAcquisitionHints, hints: ResourceAcquisitionHints) {
	const parsedDate = Date.parse(acquired.publishedDate ?? '');
	return {
		originalLang: canonicalizeOptionalResourceLang(acquired.originalLang) ?? canonicalizeOptionalResourceLang(hints.originalLang) ?? 'und',
		publishedDate: Number.isNaN(parsedDate) ? hints.publishedDate : new Date(parsedDate).toISOString(),
		summary: acquired.summary?.trim() || hints.summary?.trim() || null,
	};
}

export const ResourceCreatorsSchema = z.array(ResourceCreatorSchema);

const ResourceIdentifierSchemeSchema = z.enum([...PAPER_IDENTIFIER_SCHEMES, ...(Object.keys(RESOURCE_PLATFORMS) as ResourcePlatform[])]);

function canonicalIdentifierValue(scheme: z.infer<typeof ResourceIdentifierSchemeSchema>, value: string): string | null {
	if (isPaperIdentifierScheme(scheme)) {
		switch (scheme) {
			case 'doi':
				return normalizeDoi(value);
			case 'arxiv':
				return normalizeArxivId(value);
			case 'openalex':
				return normalizeOpenAlexId(value);
		}
	}
	const identifier = RESOURCE_PLATFORMS[scheme].identifier.safeParse(value);
	return identifier.success ? identifier.data : null;
}

const ResourceIdentifierSchema = z
	.strictObject({ preferred: z.boolean(), scheme: ResourceIdentifierSchemeSchema, value: z.string() })
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
