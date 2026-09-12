// Pure platform URL identity rules; acquisition and provider I/O stay in their adapters.
import { paperIdentifiersFromIdentity, resolveExactPaperInput } from '../../shared/paper-identity';
import { RESOURCE_PLATFORMS, type ResourceIdentifier, type ResourcePlatform } from '../../shared/resource';

export type PlatformResourceUrl = { resourcePlatform: ResourcePlatform; platformId: string; canonicalUrl: string };
export type ResourceSubjectIdentity = { identifiers: ResourceIdentifier[]; normalizedUrl: string };

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

export function canonicalizeWebResourceUrl(url: URL): string {
	url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
	for (const parameter of TRACKING_PARAMS) url.searchParams.delete(parameter);
	url.searchParams.sort();
	return url.toString();
}

function parseHackerNewsResourceUrl(url: URL) {
	const itemId = RESOURCE_PLATFORMS.hackernews.identifier.safeParse(url.searchParams.get('id'));
	return itemId.success
		? {
				resourcePlatform: 'hackernews' as const,
				platformId: itemId.data,
				canonicalUrl: `https://news.ycombinator.com/item?id=${itemId.data}`,
			}
		: null;
}

function parseLessWrongResourceUrl(url: URL) {
	const postId = RESOURCE_PLATFORMS.lesswrong.identifier.safeParse(url.pathname.match(/^\/posts\/([^/]+)(?:\/|$)/)?.[1]);
	return postId.success
		? {
				resourcePlatform: 'lesswrong' as const,
				platformId: postId.data,
				canonicalUrl: `https://lesswrong.com/posts/${postId.data}`,
			}
		: null;
}

export function isTwitterHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	return lower === 'twitter.com' || lower.endsWith('.twitter.com') || lower === 'x.com' || lower.endsWith('.x.com');
}

export function parseTwitterResourceUrl(url: URL) {
	const candidate = url.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1] ?? url.pathname.match(/^\/i\/article\/(\d+)(?:\/|$)/)?.[1];
	const tweetId = RESOURCE_PLATFORMS.twitter.identifier.safeParse(candidate);
	return tweetId.success
		? {
				resourcePlatform: 'twitter' as const,
				platformId: tweetId.data,
				canonicalUrl: `https://x.com/i/status/${tweetId.data}`,
			}
		: null;
}

function parseYouTubeResourceUrl(url: URL) {
	const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
	const [kind, maybeId] = url.pathname.split('/').filter(Boolean);
	const candidate =
		url.searchParams.get('v') ??
		(hostname === 'youtu.be' || hostname.endsWith('.youtu.be')
			? kind
			: ['embed', 'shorts', 'live', 'v'].includes(kind ?? '')
				? maybeId
				: null);
	const videoId = RESOURCE_PLATFORMS.youtube.identifier.safeParse(candidate);
	return videoId.success
		? {
				resourcePlatform: 'youtube' as const,
				platformId: videoId.data,
				canonicalUrl: `https://youtube.com/watch?v=${videoId.data}`,
			}
		: null;
}

export function resolvePlatformResourceUrl(url: URL): PlatformResourceUrl | null {
	const hostname = url.hostname.toLowerCase();
	if (hostname === 'ycombinator.com' || hostname.endsWith('.ycombinator.com')) return parseHackerNewsResourceUrl(url);
	if (hostname === 'lesswrong.com' || hostname.endsWith('.lesswrong.com')) return parseLessWrongResourceUrl(url);
	if (isTwitterHostname(hostname)) {
		return parseTwitterResourceUrl(url);
	}
	if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be' || hostname.endsWith('.youtu.be')) {
		return parseYouTubeResourceUrl(url);
	}
	return null;
}

export function resolveResourceSubject(value: string | null | undefined): ResourceSubjectIdentity | null {
	const url = value?.trim() ? URL.parse(value) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;

	const platform = resolvePlatformResourceUrl(url);
	if (platform) {
		return {
			identifiers: [{ preferred: true, scheme: platform.resourcePlatform, value: platform.platformId }],
			normalizedUrl: platform.canonicalUrl,
		};
	}
	const paper = resolveExactPaperInput(url.toString());
	if (paper) return { identifiers: paperIdentifiersFromIdentity(paper.identity), normalizedUrl: paper.canonicalUrl };

	return { identifiers: [], normalizedUrl: canonicalizeWebResourceUrl(url) };
}
