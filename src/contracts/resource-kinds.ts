import { z } from 'zod';

/**
 * What a Resource can be, kept here once: web-tanstack imports this file as is, so it imports only zod. Postgres keeps
 * the same lists in CHECK constraints, and `scripts/check-sql-schema.mjs` fails when the two differ.
 */

export const RESOURCE_CREATOR_ROLES = ['author', 'editor', 'submitter', 'channel'] as const;
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
		/** The platform account behind the byline, by the id the platform never reassigns. */
		get account() {
			return z.strictObject({ platform: z.enum(RESOURCE_PLATFORM_NAMES), id: z.string().trim().min(1) }).optional();
		},
	})
	.refine((creator) => creator.given || creator.family || creator.literal, 'Creator must have a name');

export type ResourceCreator = Readonly<z.infer<typeof ResourceCreatorSchema>>;

export const ResourceMediaAttachmentSchema = z.strictObject({
	kind: z.enum(['image', 'video', 'animated']),
	url: optionalHttpUrl,
	playback: z.strictObject({ url: optionalHttpUrl, type: z.enum(['video/mp4', 'application/x-mpegurl']) }).optional(),
	width: z.int().positive().optional(),
	height: z.int().positive().optional(),
});

/**
 * Every rule that depends on what a Resource is lives here, not in `kind === …` checks.
 * - `metadata`: the stable attributes stored in `kind_metadata`.
 * - `titled`: the original has its own title; a post is only its text.
 * - `translatable`: gets automatic zh-Hant and English localization.
 * - `sitePreview`: may borrow its site's preview image.
 * - `searchable`: may enter the search corpus.
 */
export const RESOURCE_KINDS = {
	blog: { metadata: z.null(), titled: true, translatable: true, sitePreview: true, searchable: true },
	forum: { metadata: z.strictObject({}), titled: true, translatable: true, sitePreview: true, searchable: true },
	/** A web page that is not an article: a repository, documentation, a reference entry, a product page or a listing. */
	page: { metadata: z.null(), titled: true, translatable: true, sitePreview: true, searchable: true },
	post: {
		metadata: z.strictObject({ attachments: z.array(ResourceMediaAttachmentSchema).max(16) }),
		titled: false,
		translatable: true,
		sitePreview: false,
		searchable: true,
	},
	video: {
		metadata: z.strictObject({ durationSeconds: z.int().positive().optional() }),
		titled: true,
		translatable: true,
		sitePreview: false,
		searchable: true,
	},
	paper: {
		metadata: z.strictObject({
			venue: z.string().trim().min(1).optional(),
			year: z.int().positive().optional(),
			citedByCount: z.int().nonnegative().optional(),
			referenceCount: z.int().nonnegative().optional(),
			pdfUrl: optionalHttpUrl.optional(),
		}),
		titled: true,
		translatable: true,
		sitePreview: true,
		searchable: true,
	},
	image: { metadata: z.null(), titled: true, translatable: false, sitePreview: false, searchable: false },
	file: { metadata: z.null(), titled: true, translatable: false, sitePreview: false, searchable: true },
} as const satisfies Record<
	string,
	{ metadata: z.ZodType; titled: boolean; translatable: boolean; sitePreview: boolean; searchable: boolean }
>;

export type ResourceKind = keyof typeof RESOURCE_KINDS;
export type ResourceKindMetadata = z.infer<(typeof RESOURCE_KINDS)[ResourceKind]['metadata']>;
export const RESOURCE_KIND_NAMES = Object.keys(RESOURCE_KINDS) as ResourceKind[];

/** The kinds whose `rule` is true, for SQL `kind IN (…)` filters. */
export type ResourceKindRule = 'titled' | 'translatable' | 'sitePreview' | 'searchable';

export function resourceKindsWhere(rule: ResourceKindRule, value = true): ResourceKind[] {
	return RESOURCE_KIND_NAMES.filter((kind) => RESOURCE_KINDS[kind][rule] === value);
}

/** The kinds whose `rule` holds. */
export type ResourceKindWith<R extends ResourceKindRule> = {
	[K in ResourceKind]: (typeof RESOURCE_KINDS)[K][R] extends true ? K : never;
}[ResourceKind];

export function kindHas<R extends ResourceKindRule>(kind: ResourceKind, rule: R): kind is ResourceKindWith<R> {
	return RESOURCE_KINDS[kind][rule];
}

/** The platforms a Resource is recognised on, and the kinds each hosts. A tweet is a post, or a blog when it publishes an X Article. */
export const RESOURCE_PLATFORM_KINDS = {
	lesswrong: ['blog'],
	hackernews: ['forum'],
	twitter: ['post', 'blog'],
	youtube: ['video'],
} as const satisfies Record<string, readonly ResourceKind[]>;

export type ResourcePlatform = keyof typeof RESOURCE_PLATFORM_KINDS;
export const RESOURCE_PLATFORM_NAMES = Object.keys(RESOURCE_PLATFORM_KINDS) as ResourcePlatform[];

export const ResourceCreatorsSchema = z.array(ResourceCreatorSchema);
export type ResourceMediaAttachment = Readonly<z.infer<typeof ResourceMediaAttachmentSchema>>;

export const PAPER_IDENTIFIER_SCHEMES = ['doi', 'arxiv', 'openalex'] as const;
/** Every `resource_keys` scheme: the URLs a Resource was asked by, its paper identifiers, and its platform id. */
export const RESOURCE_KEY_SCHEMES = ['url', ...PAPER_IDENTIFIER_SCHEMES, ...RESOURCE_PLATFORM_NAMES] as const;

export const ENTITY_TYPES = ['person', 'organization', 'product', 'work', 'event', 'place', 'concept'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
