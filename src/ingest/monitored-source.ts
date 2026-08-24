import { sha256Hex } from '@core-shared/hash';
import { canonicalizeOptionalResourceLang } from '@core-shared/resource';
import { normalizeUrl, parseExternalHttpUrl, validatedExternalMediaUrl } from '@core-shared/url';
import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadFeed } from './platforms/rss-feed';
import { parseTwitterProfileInput } from './platforms/twitter-acquisition';
import { fetchYouTubeChannel } from './platforms/youtube-acquisition';
import type { ResourceDraftTarget } from './workflow';

// Resolves a feed/account/channel input into the exact source row the crons can
// poll. Ordinary resource URLs use resource ingestion instead of this RPC.

type ResolvedMonitoredSource = {
	monitorKind: 'feed' | 'twitter';
	handle: string;
	name: string;
	siteUrl: string | null;
	avatarUrl: string | null;
};

const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;

async function resolveYouTubeSource(env: CoreEnv, input: string, url: URL | null): Promise<ResolvedMonitoredSource> {
	const segments = url?.pathname.split('/').filter(Boolean) ?? [];
	const feedChannelId = url?.searchParams.get('channel_id');
	const channelId = [input, feedChannelId, segments[0] === 'channel' ? segments[1] : null].find((candidate) =>
		YOUTUBE_CHANNEL_ID_RE.test(candidate ?? ''),
	);
	let id = channelId;
	let title: string | null = null;
	let avatarUrl: string | null = null;
	if (channelId) {
		try {
			const channel = await fetchYouTubeChannel(env.YOUTUBE_API_KEY, { id: channelId });
			if (channel) ({ id, title, avatarUrl } = channel);
		} catch (error) {
			console.warn({
				tag: 'YOUTUBE',
				msg: 'Using channel ID without optional metadata',
				channelId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	} else {
		const handle = YOUTUBE_HANDLE_RE.test(segments[0] ?? '') ? segments[0].slice(1) : null;
		if (!handle) throw new Error('Enter a YouTube channel URL or channel ID.');
		const channel = await fetchYouTubeChannel(env.YOUTUBE_API_KEY, { handle });
		if (!channel) throw new Error(`YouTube channel @${handle} was not found.`);
		({ id, title, avatarUrl } = channel);
	}
	if (!id) throw new Error('Enter a YouTube channel URL or channel ID.');
	return {
		monitorKind: 'feed',
		handle: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
		name: title ?? id,
		siteUrl: `https://www.youtube.com/channel/${id}`,
		avatarUrl,
	};
}

export async function resolveMonitoredSource(env: CoreEnv, input: string): Promise<ResolvedMonitoredSource> {
	const raw = typeof input === 'string' ? input.trim() : '';
	if (!raw) throw new Error('Source input is required.');
	const url = parseExternalHttpUrl(raw);
	const host = url?.hostname.toLowerCase().replace(/^(www|m)\./, '');
	if (YOUTUBE_CHANNEL_ID_RE.test(raw) || host === 'youtube.com') return resolveYouTubeSource(env, raw, url);
	const twitterHandle =
		host === 'x.com' || host === 'twitter.com' || !url ? (parseTwitterProfileInput(raw, url)?.toLowerCase() ?? null) : null;
	if (host === 'x.com' || host === 'twitter.com' || (!url && twitterHandle)) {
		if (!twitterHandle) throw new Error('Enter a valid X/Twitter handle or profile URL.');
		return {
			monitorKind: 'twitter',
			handle: twitterHandle,
			name: `@${twitterHandle}`,
			siteUrl: `https://x.com/${twitterHandle}`,
			avatarUrl: null,
		};
	}
	if (url) {
		const { effectiveUrl: feedUrl, title } = await loadFeed(url.toString());
		const feedHost = feedUrl.hostname.toLowerCase().replace(/^www\./, '');
		return {
			monitorKind: 'feed',
			handle: feedUrl.toString(),
			name: title ?? feedHost,
			siteUrl: feedUrl.origin,
			avatarUrl: null,
		};
	}
	throw new Error('Enter a feed URL, YouTube channel URL or ID, or X/Twitter handle.');
}

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	avatarUrl: string | null;
	scrapedAt: Date | null;
	createdAt: Date;
};

export type SourceResourceDraft = {
	sourceId: string;
	url: string;
	publishedDate: Date | null;
	summary: string | null;
	originalLang?: string;
	keywords?: string[];
	sourceAvatarUrl?: string | null;
};

const SOURCE_DRAFT_WORKFLOW_REVISION = 'source-draft-v5';
const WORKFLOW_CREATE_BATCH_SIZE = 100;

/** Admit feed/account discoveries as deterministic process-first Workflow drafts. */
export async function admitDiscoveredSourceResources(env: CoreEnv, drafts: SourceResourceDraft[]): Promise<number> {
	const instances = await Promise.all(
		drafts.map(async (draft) => {
			const originalLang = canonicalizeOptionalResourceLang(draft.originalLang);
			if (draft.publishedDate && !Number.isFinite(draft.publishedDate.getTime())) throw new Error('Source published date is invalid');
			const parsedUrl = parseExternalHttpUrl(draft.url.trim());
			if (!parsedUrl) throw new Error('Source resource URL must be external http(s)');
			const summary = draft.summary?.trim() || null;
			const sourceAvatarUrl = validatedExternalMediaUrl(draft.sourceAvatarUrl);
			const target = {
				kind: 'draft',
				admission: { kind: 'source', sourceId: draft.sourceId.trim() },
				url: normalizeUrl(parsedUrl.toString()),
				sourceHints: {
					...(summary ? { summary } : {}),
					...(originalLang ? { originalLang } : {}),
					...(draft.publishedDate ? { publishedDate: draft.publishedDate.toISOString() } : {}),
					...(draft.keywords?.length ? { keywords: draft.keywords } : {}),
					...(sourceAvatarUrl ? { sourceAvatarUrl } : {}),
				},
			} satisfies ResourceDraftTarget;
			return {
				id: `${SOURCE_DRAFT_WORKFLOW_REVISION}-${await sha256Hex(JSON.stringify(target))}`,
				params: target,
			};
		}),
	);
	let created = 0;
	for (let offset = 0; offset < instances.length; offset += WORKFLOW_CREATE_BATCH_SIZE) {
		created += (await env.RESOURCE_PROCESSING_V2_WORKFLOW.createBatch(instances.slice(offset, offset + WORKFLOW_CREATE_BATCH_SIZE))).length;
	}
	return created;
}

/** Loads enabled sources due to be polled by the requested monitor. */
export async function loadMonitoredSources(db: NodePgDatabase, monitor: 'feed' | 'twitter'): Promise<MonitoredSource[]> {
	const monitorFilter =
		monitor === 'twitter'
			? sql`monitor_kind = 'twitter'`
			: sql`monitor_kind = 'feed'
					AND (handle NOT LIKE 'https://www.youtube.com/feeds/videos.xml?channel_id=%'
						OR scraped_at IS NULL
						OR scraped_at < NOW() - INTERVAL '30 minutes')`;
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
		  AND ${monitorFilter}
	`);
	return result.rows;
}

export async function markSourcesScraped(db: NodePgDatabase, sourceIds: string[], scrapedAt: Date = new Date()): Promise<number> {
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
export async function recordSourceFailure(db: NodePgDatabase, sourceId: string, error: unknown): Promise<void> {
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
