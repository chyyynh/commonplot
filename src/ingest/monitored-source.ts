import { parseExternalHttpUrl, parseTwitterUsername } from '@core-shared/url';
import type { CoreDb } from '@db/connection';
import { inArray, sql } from 'drizzle-orm';
import { loadFeed } from './platforms/rss-feed';

// Resolves an explicitly requested monitor (feed / account / channel) into the
// exact source row the crons can poll. Ordinary web URLs belong to resource
// ingestion and never enter this path.

export type ResolveMonitoredSourceInput = { platform: 'rss' | 'lesswrong' | 'twitter' | 'youtube'; input: string };

type ResolvedMonitoredSource = {
	platform: ResolveMonitoredSourceInput['platform'];
	handle: string;
	name: string;
	siteUrl: string | null;
	avatarUrl: string | null;
};

const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_RE = /^@?[A-Za-z0-9._-]{3,30}$/;

async function resolveFeedSource(input: string): Promise<ResolvedMonitoredSource> {
	const { effectiveUrl: feedUrl, title } = await loadFeed(input);
	const host = feedUrl.hostname.toLowerCase().replace(/^www\./, '');
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
	const response = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&${query}&key=${env.YOUTUBE_API_KEY}`, {
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`YouTube channel lookup failed with HTTP ${status}`);
	}
	const data = await response.json<{
		items?: { id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
	}>();
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
	};
}

export async function resolveMonitoredSource(env: CoreEnv, input: ResolveMonitoredSourceInput): Promise<ResolvedMonitoredSource> {
	const raw = typeof input.input === 'string' ? input.input.trim() : '';
	if (!raw) throw new Error('Source input is required.');
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

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	avatarUrl: string | null;
	scrapedAt: Date | null;
	createdAt: Date;
};

/** Loads enabled sources due to be polled by the requested monitor. */
export async function loadMonitoredSources(db: CoreDb, monitor: 'feed' | 'twitter'): Promise<MonitoredSource[]> {
	const platformFilter =
		monitor === 'twitter'
			? sql`platform = 'twitter'`
			: sql`platform IN ('rss', 'lesswrong', 'youtube')
					AND (platform <> 'youtube' OR scraped_at IS NULL OR scraped_at < NOW() - INTERVAL '30 minutes')`;
	const result = await db.execute<MonitoredSource>(sql`
		SELECT
			id::text AS id,
			name,
			handle,
			avatar_url AS "avatarUrl",
			scraped_at AS "scrapedAt",
			created_at AS "createdAt"
		FROM sources
		WHERE enabled = true
		  AND ${platformFilter}
	`);
	return result.rows;
}

export async function markSourcesScraped(db: CoreDb, sourceIds: string[], scrapedAt: Date = new Date()): Promise<number> {
	if (!sourceIds.length) return 0;
	if (!Number.isFinite(scrapedAt.getTime())) throw new Error('Source watermark is invalid');
	const updated = await db.execute(sql`
		UPDATE sources
		SET scraped_at = ${scrapedAt},
		    updated_at = NOW(),
		    status = 'active',
		    scrape_state = NULL
		WHERE ${inArray(sql`id`, sourceIds)}
		  AND (scraped_at IS NULL OR scraped_at <= ${scrapedAt})
		RETURNING id
	`);
	return updated.rows.length;
}

const PENDING_VALIDATION_FAILURE_LIMIT = 3;

// Failure bookkeeping must not break per-source cron isolation. Pending
// sources are disabled after three failed validation attempts; active sources
// keep monitoring through transient provider failures.
export async function recordSourceFailure(db: CoreDb, sourceId: string, error: unknown): Promise<void> {
	const failedAt = new Date();
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
	try {
		await db.execute(sql`
			UPDATE sources SET
				scrape_state = jsonb_build_object(
					'consecutiveFailures', COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1,
					'lastError', ${message}::text,
					'lastFailureAt', ${failedAt.toISOString()}::text
				),
				status = CASE
					WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= ${PENDING_VALIDATION_FAILURE_LIMIT}
					THEN 'failed' ELSE status END,
				enabled = CASE
					WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= ${PENDING_VALIDATION_FAILURE_LIMIT}
					THEN false ELSE enabled END,
				updated_at = ${failedAt}
			WHERE id = ${sourceId}
		`);
	} catch (recordError) {
		console.error({
			tag: 'SOURCES',
			msg: 'Failed to record source failure',
			sourceId,
			error: recordError instanceof Error ? recordError.message : String(recordError),
		});
	}
}
