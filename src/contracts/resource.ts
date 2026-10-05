import { z } from 'zod';
import {
	isPaperIdentifierScheme,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	PAPER_IDENTIFIER_SCHEMES,
} from './paper-identity.ts';

const RESOURCE_CREATOR_ROLES = ['author', 'editor', 'submitter', 'channel'] as const;
/** An http(s) URL without credentials. */
export function httpUrlSchema(options: { normalize?: boolean } = {}) {
	return z.url({ ...options, protocol: /^https?$/ }).refine((value) => {
		const url = URL.parse(value);
		return !!url && !url.username && !url.password;
	}, 'URL credentials are not allowed');
}
const optionalHttpUrl = httpUrlSchema();
const ResourceCreatorSchema = z
	.strictObject({
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

const ResourceMediaAttachmentSchema = z.strictObject({
	kind: z.enum(['image', 'video', 'animated']),
	url: optionalHttpUrl,
	playback: z.strictObject({ url: optionalHttpUrl, type: z.enum(['video/mp4', 'application/x-mpegurl']) }).optional(),
	width: z.int().positive().optional(),
	height: z.int().positive().optional(),
});

export const RESOURCE_KIND_METADATA = {
	blog: z.strictObject({ siteName: z.string().trim().min(1).optional() }).nullable(),
	forum: z.strictObject({
		points: z.int().nonnegative().optional(),
		commentCount: z.int().nonnegative().optional(),
	}),
	post: z.strictObject({ attachments: z.array(ResourceMediaAttachmentSchema).max(16) }),
	video: z.strictObject({
		durationSeconds: z.int().positive().optional(),
	}),
	paper: z.strictObject({
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
export type ResourceKindMetadata = z.infer<(typeof RESOURCE_KIND_METADATA)[ResourceKind]>;

// A tweet is a post, or a blog when it publishes an X Article; its identity is the tweet either way.
export const RESOURCE_PLATFORMS = {
	lesswrong: { kinds: ['blog'], identifier: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) },
	hackernews: { kinds: ['forum'], identifier: z.string().regex(/^[1-9]\d*$/) },
	twitter: { kinds: ['post', 'blog'], identifier: z.string().regex(/^\d+$/) },
	youtube: { kinds: ['video'], identifier: z.string().regex(/^[A-Za-z0-9_-]{11}$/) },
} as const satisfies Record<string, { kinds: readonly ResourceKind[]; identifier: z.ZodString }>;
export type ResourcePlatform = keyof typeof RESOURCE_PLATFORMS;
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

const ENTITY_TYPES = ['person', 'organization', 'product', 'work', 'event', 'place', 'concept'] as const;

/**
 * Case, width, spacing, dashes and punctuation never tell two entities apart. A parenthetical qualifier,
 * the maker, does only for a single bare word ("Pi (Inflection AI)"); a longer or versioned name is
 * already specific, so "GPT-6 Astra (OpenAI)" is "GPT-6 Astra".
 */
export function entityKey(name: string): string {
	const normalized = name.normalize('NFKC').toLowerCase().trim();
	const bare = normalized.replace(/\s*\([^)]*\)\s*$/u, '');
	const specific = bare !== normalized && (/\s/u.test(bare) || /\d/u.test(bare));
	return (specific ? bare : normalized).replace(/[\s\p{Pd}_.·・'’"]+/gu, '');
}

export type EntityType = (typeof ENTITY_TYPES)[number];

/** `weight`: how much the Resource is about the entity, from 0 (named in passing) to 1 (its sole subject). */
export type ResourceEntity = Readonly<{
	name: string;
	type: EntityType;
	weight: number;
}>;
