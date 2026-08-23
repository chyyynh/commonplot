import { RESOURCE_TYPES } from './resource.ts';

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

const DOMAIN_ALIASES: Record<string, string> = {
	'twitter.com': 'x.com',
	'www.twitter.com': 'x.com',
	'mobile.twitter.com': 'x.com',
	'www.x.com': 'x.com',
};
const YOUTUBE_HOST = 'youtube.com';
const YOUTUBE_SHORT_HOST = 'youtu.be';
const LESSWRONG_HOST = 'lesswrong.com';
const TWITTER_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWITTER_NON_PROFILE_PATHS = new Set(['home', 'i', 'intent', 'search', 'share']);

function hostMatches(hostname: string, host: string): boolean {
	return hostname === host || hostname.endsWith(`.${host}`);
}

function canonicalHost(hostname: string): string {
	const lower = hostname.toLowerCase();
	return DOMAIN_ALIASES[lower] ?? (lower.startsWith('www.') ? lower.slice(4) : lower);
}

function isYouTubeHost(hostname: string): boolean {
	return hostMatches(hostname, YOUTUBE_HOST) || hostMatches(hostname, YOUTUBE_SHORT_HOST);
}

function isTwitterHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	return hostMatches(lower, 'twitter.com') || hostMatches(lower, 'x.com');
}

export function parseExternalHttpUrl(value: string | null | undefined, base?: string): URL | null {
	const url = value?.trim() ? URL.parse(value, base) : null;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
	return url;
}

export function parseTwitterUsername(value: string | null | undefined): string | null {
	const input = value?.trim();
	if (!input) return null;

	const url = parseExternalHttpUrl(input);
	const candidate = url ? url.pathname.split('/').filter(Boolean)[0] : input.replace(/^@/, '');
	if (url && !isTwitterHost(url.hostname)) return null;
	if (!candidate || TWITTER_NON_PROFILE_PATHS.has(candidate.toLowerCase())) return null;
	return TWITTER_USERNAME_RE.test(candidate) ? candidate : null;
}

/** Canonical HTTPS URL for external media. */
export function validatedExternalMediaUrl(rawUrl: string | null | undefined, base?: string): string | null {
	const url = parseExternalHttpUrl(rawUrl, base);
	if (!url) return null;
	url.protocol = 'https:';
	return url.toString();
}

export function normalizeUrl(url: string): string {
	const parsed = URL.parse(url);
	if (!parsed) return url;

	parsed.hostname = canonicalHost(parsed.hostname);
	const detected = detectResourceUrl(parsed.toString());
	if (detected) return canonicalResourcePlatformUrl(detected.resourcePlatform, detected.platformId);

	for (const param of TRACKING_PARAMS) parsed.searchParams.delete(param);
	parsed.searchParams.sort();
	return parsed.toString();
}

export function canonicalResourcePlatformUrl(
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'],
	platformId: string,
): string {
	switch (resourcePlatform) {
		case 'hackernews':
			return `https://news.ycombinator.com/item?id=${platformId}`;
		case 'lesswrong':
			return `https://lesswrong.com/posts/${platformId}`;
		case 'twitter':
			return `https://x.com/i/status/${platformId}`;
		case 'youtube':
			return `https://youtube.com/watch?v=${platformId}`;
	}
}

function extractYouTubeId(url: string): string | null {
	const parsed = URL.parse(url);
	if (!parsed) return null;
	const hostname = canonicalHost(parsed.hostname);
	if (!isYouTubeHost(hostname)) return null;
	const identifier = RESOURCE_TYPES.video.platforms.find(({ name }) => name === 'youtube')?.identifier;
	if (!identifier) return null;

	const watchId = parsed.searchParams.get('v');
	const parsedWatchId = identifier.safeParse(watchId);
	if (parsedWatchId.success) return parsedWatchId.data;

	const [kind, maybeId] = parsed.pathname.split('/').filter(Boolean);
	const pathId = hostMatches(hostname, YOUTUBE_SHORT_HOST) ? kind : ['embed', 'shorts', 'live', 'v'].includes(kind ?? '') ? maybeId : null;
	const parsedPathId = identifier.safeParse(pathId);
	return parsedPathId.success ? parsedPathId.data : null;
}

export function extractTweetId(url: string): string | null {
	const parsed = URL.parse(url);
	if (!parsed || !isTwitterHost(parsed.hostname)) return null;
	const candidate =
		parsed.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1] ?? parsed.pathname.match(/^\/i\/article\/(\d+)(?:\/|$)/)?.[1];
	const identifier = RESOURCE_TYPES.post.platforms.find(({ name }) => name === 'twitter')?.identifier.safeParse(candidate);
	return identifier?.success ? identifier.data : null;
}

export function extractHackerNewsId(url: string): string | null {
	const parsed = URL.parse(url);
	if (!parsed || !hostMatches(parsed.hostname.toLowerCase(), 'ycombinator.com')) return null;
	const identifier = RESOURCE_TYPES.forum.platforms
		.find(({ name }) => name === 'hackernews')
		?.identifier.safeParse(parsed.searchParams.get('id'));
	return identifier?.success ? identifier.data : null;
}

function extractLessWrongPostId(url: string): string | null {
	const parsed = URL.parse(url);
	if (!parsed || !hostMatches(parsed.hostname.toLowerCase(), LESSWRONG_HOST)) return null;
	const candidate = parsed.pathname.match(/^\/posts\/([^/]+)(?:\/|$)/)?.[1];
	const identifier = RESOURCE_TYPES.blog.platforms.find(({ name }) => name === 'lesswrong')?.identifier.safeParse(candidate);
	return identifier?.success ? identifier.data : null;
}

type DetectedResourceUrl = Readonly<{
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'];
	platformId: string;
}>;

export function detectResourceUrl(url: string | null | undefined): DetectedResourceUrl | null {
	if (!url) return null;
	const youtubeId = extractYouTubeId(url);
	if (youtubeId) return { resourcePlatform: 'youtube', platformId: youtubeId };
	const tweetId = extractTweetId(url);
	if (tweetId) return { resourcePlatform: 'twitter', platformId: tweetId };
	const hackerNewsId = extractHackerNewsId(url);
	if (hackerNewsId) return { resourcePlatform: 'hackernews', platformId: hackerNewsId };
	const lessWrongPostId = extractLessWrongPostId(url);
	if (lessWrongPostId) return { resourcePlatform: 'lesswrong', platformId: lessWrongPostId };
	return null;
}
