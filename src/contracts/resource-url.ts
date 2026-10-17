import normalizeUrl, { type Options } from 'normalize-url';
import { z } from 'zod';
import { canonicalPaperUrl, normalizePaperIdentifiers, paperIdentifiersFromIdentity } from './paper-identity';
import type { ResourceIdentifier } from './resource';
import { httpUrlSchema, RESOURCE_PLATFORM_NAMES, type ResourcePlatform } from './resource-kinds';

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

export type ResolvedResourceUrl = {
	url: string;
	normalizedUrl: string;
	resourcePlatform: ResourcePlatform | null;
	identifiers: ResourceIdentifier[];
};

/**
 * Generic identity: RFC 3986 syntax normalization via normalize-url plus removal of query parameters
 * that never change which document a URL denotes (campaign/click ids, analytics linkers, referrer tags,
 * access credentials and signatures). The package version is pinned: its output is the stored identity.
 */
const GENERIC_IDENTITY_OPTIONS: Options = {
	forceHttps: true,
	stripHash: true,
	removeDirectoryIndex: true,
	removeExplicitPort: true,
	removeQueryParameters: [
		/^utm_/i,
		/^x-amz-/i,
		/^hsa_/i,
		/^(pk|mtm|piwik)_/i,
		// Ad and campaign click identifiers
		'fbclid',
		'gclid',
		'dclid',
		'gbraid',
		'wbraid',
		'msclkid',
		'yclid',
		'twclid',
		'ttclid',
		'igshid',
		'igsh',
		'srsltid',
		's_kwcid',
		'ef_id',
		// Email and marketing automation
		'mc_cid',
		'mc_eid',
		'mkt_tok',
		'_hsenc',
		'_hsmi',
		'hsCtaTracking',
		'vero_id',
		'oly_anon_id',
		'oly_enc_id',
		'wickedid',
		'ncid',
		'cmpid',
		// Analytics linkers and referrer tags
		'_ga',
		'_gl',
		'ref',
		'ref_src',
		'ref_url',
		'referrer',
		'si',
		'trk',
		'trkInfo',
		'sk',
		'linkId',
		// Access credentials and signatures authorize a fetch; they do not identify a document
		'access_token',
		'token',
		'auth',
		'signature',
		'sig',
		'expires',
	],
};

/**
 * Share decorations that make a publisher serve an interstitial instead of the document
 * (Substack's subscribe page). They leave the fetch URL as well as the identity.
 */
const INTERSTITIAL_QUERY_PARAMETERS = ['showWelcomeOnShare'];

/**
 * Pure resource identity resolution. Keep the fetch URL intact, including PDF paths and signed queries. */
export function resolveResourceUrl(value: string | null | undefined): ResolvedResourceUrl | null {
	const parsed = value ? URL.parse(value) : null;
	if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
	for (const parameter of INTERSTITIAL_QUERY_PARAMETERS) if (parsed.searchParams.has(parameter)) parsed.searchParams.delete(parameter);
	const url = parsed.toString();
	const hostname = parsed.hostname.replace(/^www\d*\./, '');
	const path = parsed.pathname;
	for (const resourcePlatform of RESOURCE_PLATFORM_NAMES) {
		const platform = RESOURCE_PLATFORMS[resourcePlatform];
		const id = platform.identify(hostname, parsed);
		if (id === undefined) continue;
		// A platform host without a Resource id (a profile, a search page) is an ordinary web page.
		if (!platform.identifier.validate(id)) break;
		return {
			url,
			normalizedUrl: platform.url(id!),
			resourcePlatform,
			identifiers: [{ preferred: true, scheme: resourcePlatform, value: id! }],
		};
	}

	// Query/fragment decorations do not form part of an exact bibliographic identifier.
	const paperUrl = `${parsed.origin}${path}`;
	const { doi, arxivId, openAlexId } = normalizePaperIdentifiers(paperUrl);
	if (doi || arxivId || openAlexId) {
		const identity = { ...(arxivId ? { arxivId } : doi ? { doi } : {}), ...(openAlexId ? { openAlexId } : {}) };
		return { url, normalizedUrl: canonicalPaperUrl(identity), resourcePlatform: null, identifiers: paperIdentifiersFromIdentity(identity) };
	}

	parsed.hostname = hostname;
	return { url, normalizedUrl: normalizeUrl(parsed.toString(), GENERIC_IDENTITY_OPTIONS), resourcePlatform: null, identifiers: [] };
}

export const ResourceUrlSchema = httpUrlSchema({ normalize: true });
