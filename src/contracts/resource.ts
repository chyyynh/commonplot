import { z } from 'zod';
import { isPaperIdentifierScheme, normalizeArxivId, normalizeDoi, normalizeOpenAlexId } from './paper-identity.ts';
import { type EntityType, PAPER_IDENTIFIER_SCHEMES, RESOURCE_PLATFORM_NAMES, type ResourcePlatform } from './resource-kinds.ts';

/**
 * How each platform names a Resource: `identify` reads the platform id from a URL on one of its hosts, and `url` is
 * the canonical URL built from that id. Which kinds it hosts is in `resource-kinds.ts`.
 */
export const RESOURCE_PLATFORMS = {
	lesswrong: {
		identifier: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
		identify: (host, url) =>
			host === 'lesswrong.com' || host.endsWith('.lesswrong.com')
				? (url.pathname.match(/^\/posts\/([^/]+)(?:\/|$)/)?.[1] ?? null)
				: undefined,
		url: (id) => `https://lesswrong.com/posts/${id}`,
	},
	hackernews: {
		identifier: z.string().regex(/^[1-9]\d*$/),
		identify: (host, url) => (host === 'news.ycombinator.com' && url.pathname === '/item' ? url.searchParams.get('id') : undefined),
		url: (id) => `https://news.ycombinator.com/item?id=${id}`,
	},
	twitter: {
		identifier: z.string().regex(/^\d+$/),
		identify: (host, url) => (isXHost(host) ? (url.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1] ?? null) : undefined),
		url: (id) => `https://x.com/i/status/${id}`,
	},
	youtube: {
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
	ResourcePlatform,
	{
		identifier: z.ZodString;
		/** `undefined`: not this platform's host; `null`: its host, but no Resource id in the URL. */
		identify: (host: string, url: URL) => string | null | undefined;
		url: (id: string) => string;
	}
>;

/** twitter.com, x.com, or one of their subdomains. */
export function isXHost(hostname: string): boolean {
	return /(^|\.)(twitter|x)\.com$/.test(hostname);
}

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

/** `weight`: how much the Resource is about the entity, from 0 (named in passing) to 1 (its sole subject). */
export type ResourceEntity = Readonly<{
	name: string;
	type: EntityType;
	weight: number;
}>;
