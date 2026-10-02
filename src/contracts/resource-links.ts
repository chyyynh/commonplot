import type { Nodes } from 'mdast';
import { parseMarkdown } from './markdown';
import { canonicalPaperUrl } from './paper-identity';
import { type ResolvedResourceUrl, resolveResourceUrl } from './resource-url';

/** A long original's links past this many are navigation or bibliography noise, not reading paths. */
const MAX_RESOURCE_LINKS = 200;

/** Shorteners, social profiles and image CDNs are never a Resource another one points readers to. */
const NON_RESOURCE_HOSTS = [
	't.co',
	'instagram.com',
	'tiktok.com',
	'facebook.com',
	'threads.net',
	'substackcdn.com',
	'res.cloudinary.com',
	'camo.githubusercontent.com',
	'wp.com',
];
const IMAGE_PATH_RE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

function markdownLinkUrls(node: Nodes, found: string[] = []): string[] {
	if (node.type === 'link' || node.type === 'definition') found.push(node.url);
	if ('children' in node) for (const child of node.children) markdownLinkUrls(child, found);
	return found;
}

function isResourceLink(link: ResolvedResourceUrl): boolean {
	const { hostname, pathname } = new URL(link.url);
	if (NON_RESOURCE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return false;
	// On X only a status is a Resource; profiles, hashtags and searches are not.
	if (/(^|\.)(twitter|x)\.com$/.test(hostname)) return link.resourcePlatform === 'twitter';
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

const PAPER_IDENTITY_KEYS = { doi: 'doi', arxiv: 'arxivId', openalex: 'openAlexId' } as const;

/** Every normalized URL a link to this Resource is stored under: its own, and each paper identifier's canonical URL. */
export function linkedResourceUrls(normalizedUrl: string | null, identifiers: readonly { scheme: string; value: string }[]): string[] {
	const urls = identifiers.flatMap(({ scheme, value }) => {
		const key = PAPER_IDENTITY_KEYS[scheme as keyof typeof PAPER_IDENTITY_KEYS];
		return key ? [canonicalPaperUrl({ [key]: value })] : [];
	});
	return [...new Set([...(normalizedUrl ? [normalizedUrl] : []), ...urls])];
}
