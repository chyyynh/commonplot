import type { Nodes } from 'mdast';
import { parseMarkdown } from './markdown';
import { canonicalPaperUrl, isPaperIdentifierScheme, PAPER_IDENTIFIERS } from './paper-identity';
import { isXHost, type ResolvedResourceUrl, resolveResourceUrl } from './resource-url';

/** A long original's links past this many are navigation or bibliography noise, not reading paths. */
const MAX_RESOURCE_LINKS = 200;

/** Shorteners and social profiles. */
const SOCIAL_LINK_HOSTS = ['t.co', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net'];
/** Shorteners, social profiles and image CDNs are never a Resource another one points readers to. */
const NON_RESOURCE_HOSTS = [...SOCIAL_LINK_HOSTS, 'substackcdn.com', 'res.cloudinary.com', 'camo.githubusercontent.com', 'wp.com'];
const IMAGE_PATH_RE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

function isHostIn(hostname: string, hosts: readonly string[]): boolean {
	return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** A shortener or a social profile host, including its subdomains. */
export function isSocialLinkHost(hostname: string): boolean {
	return isHostIn(hostname, SOCIAL_LINK_HOSTS);
}

function markdownLinkUrls(node: Nodes, found: string[] = []): string[] {
	if (node.type === 'link' || node.type === 'definition') found.push(node.url);
	if ('children' in node) for (const child of node.children) markdownLinkUrls(child, found);
	return found;
}

function isResourceLink(link: ResolvedResourceUrl): boolean {
	const { hostname, pathname } = new URL(link.url);
	if (isHostIn(hostname, NON_RESOURCE_HOSTS)) return false;
	// On X only a status is a Resource; profiles, hashtags and searches are not.
	if (isXHost(hostname)) return link.resourcePlatform === 'twitter';
	return !IMAGE_PATH_RE.test(pathname);
}

/**
 * The distinct Resources an original links to, in reading order. Links to the Resource itself and to its
 * subject are left out: the subject is already its own relation.
 */
export function resourceLinks(content: string, excluded: readonly (string | null)[]): ResolvedResourceUrl[] {
	const seen = new Set(excluded.filter((url) => url !== null));
	const links: ResolvedResourceUrl[] = [];
	for (const url of markdownLinkUrls(parseMarkdown(content))) {
		const link = resolveResourceUrl(url);
		if (!link || seen.has(link.normalizedUrl) || !isResourceLink(link)) continue;
		seen.add(link.normalizedUrl);
		links.push(link);
		if (links.length === MAX_RESOURCE_LINKS) break;
	}
	return links;
}

/** Every normalized URL a link to this Resource is stored under: its own, and each paper identifier's canonical URL. */
export function linkedResourceUrls(normalizedUrl: string | null, identifiers: readonly { scheme: string; value: string }[]): string[] {
	const urls = identifiers.flatMap(({ scheme, value }) =>
		isPaperIdentifierScheme(scheme) ? [canonicalPaperUrl({ [PAPER_IDENTIFIERS[scheme].identityKey]: value })] : [],
	);
	return [...new Set([...(normalizedUrl ? [normalizedUrl] : []), ...urls])];
}
