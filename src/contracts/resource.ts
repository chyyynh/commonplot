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
		/** The platform account behind the byline, by the id the platform never reassigns. */
		get account() {
			return z.strictObject({ platform: z.enum(RESOURCE_PLATFORM_NAMES), id: z.string().trim().min(1) }).optional();
		},
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

/**
 * Every rule that depends on where a Resource lives. `identify` reads the platform id from a URL on one of
 * its hosts, and `url` is the canonical URL built from that id. A tweet is a post, or a blog when it
 * publishes an X Article; its identity is the tweet either way.
 */
export const RESOURCE_PLATFORMS = {
	lesswrong: {
		kinds: ['blog'],
		identifier: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
		identify: (host, url) =>
			host === 'lesswrong.com' || host.endsWith('.lesswrong.com')
				? (url.pathname.match(/^\/posts\/([^/]+)(?:\/|$)/)?.[1] ?? null)
				: undefined,
		url: (id) => `https://lesswrong.com/posts/${id}`,
	},
	hackernews: {
		kinds: ['forum'],
		identifier: z.string().regex(/^[1-9]\d*$/),
		identify: (host, url) => (host === 'news.ycombinator.com' && url.pathname === '/item' ? url.searchParams.get('id') : undefined),
		url: (id) => `https://news.ycombinator.com/item?id=${id}`,
	},
	twitter: {
		kinds: ['post', 'blog'],
		identifier: z.string().regex(/^\d+$/),
		identify: (host, url) => (isXHost(host) ? (url.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1] ?? null) : undefined),
		url: (id) => `https://x.com/i/status/${id}`,
	},
	youtube: {
		kinds: ['video'],
		identifier: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
		identify: (host, url) => {
			if (host === 'youtu.be') return url.pathname.match(/^\/([^/]+)\/?$/)?.[1] ?? null;
			if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return undefined;
			return /^\/watch\/?$/.test(url.pathname)
				? url.searchParams.get('v')
				: (url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/]+)\/?$/)?.[1] ?? null);
		},
		url: (id) => `https://youtube.com/watch?v=${id}`,
	},
} as const satisfies Record<
	string,
	{
		kinds: readonly ResourceKind[];
		identifier: z.ZodString;
		/** `undefined`: not this platform's host; `null`: its host, but no Resource id in the URL. */
		identify: (host: string, url: URL) => string | null | undefined;
		url: (id: string) => string;
	}
>;
export const RESOURCE_PLATFORM_NAMES = Object.keys(RESOURCE_PLATFORMS) as ResourcePlatform[];

/** twitter.com, x.com, or one of their subdomains. */
export function isXHost(hostname: string): boolean {
	return /(^|\.)(twitter|x)\.com$/.test(hostname);
}

export type ResourcePlatform = keyof typeof RESOURCE_PLATFORMS;
export const ResourceCreatorsSchema = z.array(ResourceCreatorSchema);

const ResourceIdentifierSchemeSchema = z.enum([...PAPER_IDENTIFIER_SCHEMES, ...RESOURCE_PLATFORM_NAMES]);

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
