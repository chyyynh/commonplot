import normalizeUrl, { type Options } from 'normalize-url';
import { z } from 'zod';
import {
	canonicalPaperUrl,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	paperIdentifiersFromIdentity,
} from '../../shared/paper-identity';
import { RESOURCE_PLATFORMS, type ResourceIdentifier, type ResourcePlatform } from '../../shared/resource';

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
 * Pure resource identity resolution. Keep the fetch URL intact, including PDF paths and signed queries. */
export function resolveResourceUrl(value: string | null | undefined): ResolvedResourceUrl | null {
	const parsed = value ? URL.parse(value) : null;
	if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
	const url = parsed.toString();
	const hostname = parsed.hostname.replace(/^www\d*\./, '');
	const path = parsed.pathname;
	let resourcePlatform: ResourcePlatform | null = null;
	let id: string | null | undefined;
	let platformUrl = '';
	if (hostname === 'news.ycombinator.com' && path === '/item') {
		resourcePlatform = 'hackernews';
		id = parsed.searchParams.get('id');
		platformUrl = `https://news.ycombinator.com/item?id=${id}`;
	} else if (hostname === 'lesswrong.com' || hostname.endsWith('.lesswrong.com')) {
		resourcePlatform = 'lesswrong';
		id = path.match(/^\/posts\/([^/]+)(?:\/|$)/)?.[1];
		platformUrl = `https://lesswrong.com/posts/${id}`;
	} else if (/(^|\.)(twitter|x)\.com$/.test(hostname)) {
		resourcePlatform = 'twitter';
		id = path.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1] ?? path.match(/^\/i\/article\/(\d+)(?:\/|$)/)?.[1];
		platformUrl = `https://x.com/i/status/${id}`;
	} else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
		resourcePlatform = 'youtube';
		id =
			hostname === 'youtu.be'
				? path.match(/^\/([^/]+)\/?$/)?.[1]
				: /^\/watch\/?$/.test(path)
					? parsed.searchParams.get('v')
					: path.match(/^\/(?:embed|shorts|live|v)\/([^/]+)\/?$/)?.[1];
		platformUrl = `https://youtube.com/watch?v=${id}`;
	}
	if (resourcePlatform && RESOURCE_PLATFORMS[resourcePlatform].identifier.validate(id)) {
		return { url, normalizedUrl: platformUrl, resourcePlatform, identifiers: [{ preferred: true, scheme: resourcePlatform, value: id! }] };
	}

	// Query/fragment decorations do not form part of an exact bibliographic identifier.
	const paperUrl = `${parsed.origin}${path}`;
	const doi = normalizeDoi(paperUrl);
	const arxivId = normalizeArxivId(paperUrl);
	const openAlexId = normalizeOpenAlexId(paperUrl);
	if (doi || arxivId || openAlexId) {
		const identity = { ...(arxivId ? { arxivId } : doi ? { doi } : {}), ...(openAlexId ? { openAlexId } : {}) };
		return { url, normalizedUrl: canonicalPaperUrl(identity), resourcePlatform: null, identifiers: paperIdentifiersFromIdentity(identity) };
	}

	parsed.hostname = hostname;
	return { url, normalizedUrl: normalizeUrl(parsed.toString(), GENERIC_IDENTITY_OPTIONS), resourcePlatform: null, identifiers: [] };
}

export const ResourceUrlSchema = z.url({ normalize: true, protocol: /^https?$/ }).refine((value) => {
	const url = URL.parse(value);
	return !!url && !url.username && !url.password;
}, 'URL credentials are not allowed');
