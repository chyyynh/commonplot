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

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

/** Pure resource identity resolution. Keep the fetch URL intact, including PDF paths and signed queries. */
export function resolveResourceUrl(value: string | null | undefined): ResolvedResourceUrl | null {
	const parsed = value ? URL.parse(value) : null;
	if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
	const url = parsed.toString();
	const hostname = parsed.hostname.replace(/^www\./, '');
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
	if (resourcePlatform && RESOURCE_PLATFORMS[resourcePlatform].identifier.safeParse(id).success) {
		return { url, normalizedUrl: platformUrl, resourcePlatform, identifiers: [{ preferred: true, scheme: resourcePlatform, value: id! }] };
	}

	// Query/fragment decorations do not form part of an exact bibliographic identifier.
	const paperUrl = `${parsed.origin}${path}`;
	const doi = normalizeDoi(paperUrl);
	const arxivId =
		normalizeArxivId(paperUrl) ?? (doi?.startsWith('10.48550/arxiv.') ? normalizeArxivId(doi.slice('10.48550/arxiv.'.length)) : null);
	const openAlexId = normalizeOpenAlexId(paperUrl);
	if (doi || arxivId || openAlexId) {
		const identity = { ...(arxivId ? { arxivId } : doi ? { doi } : {}), ...(openAlexId ? { openAlexId } : {}) };
		return { url, normalizedUrl: canonicalPaperUrl(identity), resourcePlatform: null, identifiers: paperIdentifiersFromIdentity(identity) };
	}

	parsed.hostname = hostname;
	for (const parameter of TRACKING_PARAMS) parsed.searchParams.delete(parameter);
	parsed.searchParams.sort();
	return { url, normalizedUrl: parsed.toString(), resourcePlatform: null, identifiers: [] };
}
