import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { isSourcePlatform, SOURCE_INPUT_MAX_LENGTH, type SourcePlatform } from '@core-shared/resource-types';
import { parseExternalHttpUrl, parseTwitterUsername } from '@core-shared/url';
import { parseFeed } from 'feedsmith';
import { decode } from 'html-entities';

// Resolves an explicitly requested monitor (feed / account / channel) into the
// exact source row the crons can poll. Ordinary web URLs belong to resource
// ingestion and never enter this path.

export type ResolveMonitoredSourceInput = { platform: SourcePlatform; input: string };

type ResolvedMonitoredSource = {
	platform: SourcePlatform;
	handle: string;
	name: string;
	siteUrl: string | null;
	avatarUrl: string | null;
	/** Minimum minutes between polls; omitted means every cron firing. */
	pollIntervalMinutes?: number;
};

const MAX_SOURCE_DOCUMENT_BYTES = 1024 * 1024;
/** Channels publish on the order of once a day; the RSS default of every 5 minutes is waste. */
const YOUTUBE_POLL_INTERVAL_MINUTES = 30;
const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_RE = /^@?[A-Za-z0-9._-]{3,30}$/;

function textish(value: unknown): string | null {
	if (typeof value === 'string') {
		const text = decode(value).trim();
		return text || null;
	}
	if (typeof value === 'object' && value !== null && 'value' in value) {
		return textish((value as { value: unknown }).value);
	}
	return null;
}

async function resolveFeedSource(input: string): Promise<ResolvedMonitoredSource> {
	const requestedUrl = parseExternalHttpUrl(input);
	if (!requestedUrl) throw new Error('Enter a valid feed URL (http/https).');
	const response = await fetchWithTimeout(requestedUrl.toString(), {
		headers: {
			'User-Agent': WEB_FETCH_USER_AGENT,
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
		},
	});
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Feed fetch failed with HTTP ${status}.`);
	}
	const feedUrl = parseExternalHttpUrl(response.url);
	if (!feedUrl) {
		await response.body?.cancel();
		throw new Error('Feed redirected to an invalid URL.');
	}
	let title: string | null;
	try {
		const { feed } = parseFeed(await readTextWithLimit(response, MAX_SOURCE_DOCUMENT_BYTES));
		title = textish((feed as { title?: unknown }).title);
	} catch {
		throw new Error('URL did not return a readable feed.');
	}
	const host = feedUrl.hostname.toLowerCase().replace(/^www\./, '');
	feedUrl.hash = '';
	feedUrl.hostname = feedUrl.hostname.toLowerCase();
	if (feedUrl.pathname.length > 1 && feedUrl.pathname.endsWith('/')) feedUrl.pathname = feedUrl.pathname.slice(0, -1);
	return {
		platform: host === 'lesswrong.com' ? 'lesswrong' : 'rss',
		handle: feedUrl.toString(),
		name: title ?? host,
		siteUrl: feedUrl.origin,
		avatarUrl: null,
	};
}

function resolveTwitterSource(input: string): ResolvedMonitoredSource {
	const handle = parseTwitterUsername(input);
	if (!handle) throw new Error('Enter a valid X/Twitter handle or profile URL.');
	const lower = handle.toLowerCase();
	return {
		platform: 'twitter',
		handle: lower,
		name: `@${lower}`,
		siteUrl: `https://x.com/${lower}`,
		avatarUrl: null,
	};
}

function youtubeChannelIdFromInput(input: string): string | null {
	const trimmed = input.trim();
	if (YOUTUBE_CHANNEL_ID_RE.test(trimmed)) return trimmed;
	const url = parseExternalHttpUrl(trimmed);
	if (!url) return null;
	const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
	if (host !== 'youtube.com') return null;
	const feedChannelId = url.searchParams.get('channel_id');
	if (feedChannelId && YOUTUBE_CHANNEL_ID_RE.test(feedChannelId)) return feedChannelId;
	const segments = url.pathname.split('/').filter(Boolean);
	return segments[0] === 'channel' && segments[1] && YOUTUBE_CHANNEL_ID_RE.test(segments[1]) ? segments[1] : null;
}

function youtubeHandleFromInput(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed.startsWith('@') && YOUTUBE_HANDLE_RE.test(trimmed)) return trimmed.replace(/^@/, '');
	const url = parseExternalHttpUrl(trimmed);
	if (!url) return null;
	const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
	if (host !== 'youtube.com') return null;
	const [segment] = url.pathname.split('/').filter(Boolean);
	return segment?.startsWith('@') && YOUTUBE_HANDLE_RE.test(segment) ? segment.replace(/^@/, '') : null;
}

type YouTubeChannelLookup = { id: string; title: string | null; avatarUrl: string | null };

async function fetchYouTubeChannel(env: CoreEnv, query: string): Promise<YouTubeChannelLookup | null> {
	if (!env.YOUTUBE_API_KEY) throw new Error('YouTube channel lookup is not configured.');
	const response = await fetchWithTimeout(
		`https://www.googleapis.com/youtube/v3/channels?part=snippet&${query}&key=${env.YOUTUBE_API_KEY}`,
	);
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`YouTube channel lookup failed with HTTP ${status}`);
	}
	const data = JSON.parse(await readTextWithLimit(response, 64 * 1024)) as {
		items?: { id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
	};
	const item = data.items?.[0];
	if (!item?.id) return null;
	return {
		id: item.id,
		title: item.snippet?.title?.trim() || null,
		avatarUrl: item.snippet?.thumbnails?.default?.url ?? null,
	};
}

async function resolveYouTubeSource(env: CoreEnv, input: string): Promise<ResolvedMonitoredSource> {
	const channelId = youtubeChannelIdFromInput(input);
	let channel: YouTubeChannelLookup | null;
	if (channelId) {
		// Direct ids resolve without the API being strictly necessary; the
		// lookup only enriches name/avatar, so fall back to the bare id.
		channel = (await fetchYouTubeChannel(env, `id=${channelId}`)) ?? { id: channelId, title: null, avatarUrl: null };
	} else {
		const handle = youtubeHandleFromInput(input);
		if (!handle) throw new Error('Enter a YouTube channel URL, @handle, or channel ID.');
		channel = await fetchYouTubeChannel(env, `forHandle=${encodeURIComponent(`@${handle}`)}`);
		if (!channel) throw new Error(`YouTube channel @${handle} was not found.`);
	}
	return {
		platform: 'youtube',
		handle: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`,
		name: channel.title ?? channel.id,
		siteUrl: `https://www.youtube.com/channel/${channel.id}`,
		avatarUrl: channel.avatarUrl,
		// The handle is an Atom feed, so the RSS monitor polls it. Channels publish
		// far less often than a news feed, so they opt out of the 5-minute cadence.
		pollIntervalMinutes: YOUTUBE_POLL_INTERVAL_MINUTES,
	};
}

export async function resolveMonitoredSource(env: CoreEnv, input: ResolveMonitoredSourceInput): Promise<ResolvedMonitoredSource> {
	if (!isSourcePlatform(input.platform)) throw new Error('Unsupported source platform.');
	const raw = typeof input.input === 'string' ? input.input.trim() : '';
	if (!raw) throw new Error('Source input is required.');
	if (raw.length > SOURCE_INPUT_MAX_LENGTH) throw new Error('Source input is too long.');
	switch (input.platform) {
		case 'rss':
			return resolveFeedSource(raw);
		case 'lesswrong': {
			const candidate = await resolveFeedSource(raw);
			if (candidate.platform !== 'lesswrong') throw new Error('Enter a LessWrong RSS feed URL.');
			return candidate;
		}
		case 'twitter':
			return resolveTwitterSource(raw);
		case 'youtube':
			return resolveYouTubeSource(env, raw);
	}
}
