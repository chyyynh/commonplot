import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { TranscriptResponse } from 'youtube-transcript';
import { z } from 'zod';
import { RESOURCE_TYPES } from '../../shared/resource';
import {
	literalCreator,
	materializePlatformResource,
	type PlatformAcquiredMaterial,
	type ResolvedResource,
	type ResourceAcquisitionHints,
} from './materialize';

const TRANSCRIPT_FETCH_TIMEOUT_MS = 8_000;
const YOUTUBE_API_TIMEOUT_MS = 15_000;
const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;

type YouTubeTranscriptSegment = Readonly<{ startTime: number; endTime: number; text: string }>;
type YouTubeChapter = { title: string; startTime: number; endTime?: number };
type YouTubeTranscript = Readonly<{
	segments: YouTubeTranscriptSegment[];
	language: string | null;
	chapters: YouTubeChapter[];
	chaptersFromDescription: boolean;
}>;
type YouTubeHighlights = Readonly<{
	version: '1.0';
	model: string;
	highlights: ReadonlyArray<Readonly<{ title: string; summary: string; startTime: number; endTime: number }>>;
	generatedAt: string;
}>;
export type YouTubeResourceData = Readonly<{
	transcript: YouTubeTranscript;
	highlights: YouTubeHighlights | null;
}>;

export async function resolveYouTubeMonitoredSource(youtubeApiKey: string, input: string, url: URL | null) {
	const host = url?.hostname.toLowerCase().replace(/^(www|m)\./, '');
	if (!YOUTUBE_CHANNEL_ID_RE.test(input) && host !== 'youtube.com') return null;
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
			const channel = await fetchYouTubeChannel(youtubeApiKey, { id: channelId });
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
		const channel = await fetchYouTubeChannel(youtubeApiKey, { handle });
		if (!channel) throw new Error(`YouTube channel @${handle} was not found.`);
		({ id, title, avatarUrl } = channel);
	}
	if (!id) throw new Error('Enter a YouTube channel URL or channel ID.');
	return {
		monitorKind: 'feed' as const,
		handle: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
		name: title ?? id,
		siteUrl: `https://www.youtube.com/channel/${id}`,
		avatarUrl,
	};
}

export function parseYouTubeResourceUrl(url: URL) {
	const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
	if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com') && hostname !== 'youtu.be' && !hostname.endsWith('.youtu.be')) {
		return null;
	}
	const [kind, maybeId] = url.pathname.split('/').filter(Boolean);
	const candidate =
		url.searchParams.get('v') ??
		(hostname === 'youtu.be' || hostname.endsWith('.youtu.be')
			? kind
			: ['embed', 'shorts', 'live', 'v'].includes(kind ?? '')
				? maybeId
				: null);
	const videoId = RESOURCE_TYPES.video.platforms[0].identifier.safeParse(candidate);
	return videoId.success
		? {
				resourcePlatform: 'youtube' as const,
				platformId: videoId.data,
				canonicalUrl: `https://youtube.com/watch?v=${videoId.data}`,
			}
		: null;
}

const YouTubeThumbnailSchema = z.object({ url: z.string().min(1) });
const YouTubeThumbnailsSchema = z.object({
	default: YouTubeThumbnailSchema.optional(),
	medium: YouTubeThumbnailSchema.optional(),
	high: YouTubeThumbnailSchema.optional(),
	standard: YouTubeThumbnailSchema.optional(),
	maxres: YouTubeThumbnailSchema.optional(),
});
const YouTubeCountSchema = z.string().regex(/^\d+$/);
const YouTubeApiErrorSchema = z.object({ message: z.string() });
const YouTubeVideoItemSchema = z.object({
	id: z.string().min(1),
	snippet: z.object({
		title: z.string(),
		description: z.string(),
		channelId: z.string().min(1),
		channelTitle: z.string(),
		defaultAudioLanguage: z.string().optional(),
		publishedAt: z.string().min(1),
		thumbnails: YouTubeThumbnailsSchema,
	}),
	contentDetails: z.object({ duration: z.string().min(1) }),
	statistics: z.object({
		viewCount: YouTubeCountSchema.optional(),
		likeCount: YouTubeCountSchema.optional(),
		commentCount: YouTubeCountSchema.optional(),
	}),
});
const YouTubeVideosResponseSchema = z.object({
	items: z.array(YouTubeVideoItemSchema).optional(),
	error: YouTubeApiErrorSchema.optional(),
});
const YouTubeChannelsResponseSchema = z.object({
	items: z
		.array(
			z.object({
				id: z.string().min(1),
				snippet: z.object({
					title: z.string(),
					thumbnails: YouTubeThumbnailsSchema,
				}),
			}),
		)
		.optional(),
	error: YouTubeApiErrorSchema.optional(),
});
type YouTubeThumbnails = z.infer<typeof YouTubeThumbnailsSchema>;
type YouTubeVideosResponse = z.infer<typeof YouTubeVideosResponseSchema>;
type YouTubeAcquisition = PlatformAcquiredMaterial<'youtube'> & { transcript: YouTubeTranscript };
type YouTubeResolvedResource = ResolvedResource & { youtube: YouTubeResourceData };

function bestThumbnailUrl(thumbnails: YouTubeThumbnails): string | null {
	return (
		thumbnails.maxres?.url ?? thumbnails.standard?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null
	);
}

function parseChaptersFromDescription(description: string): YouTubeChapter[] {
	const chapterRegex = /(?:^|\n)(\d{1,2}:)?(\d{1,2}):(\d{2})\s+(.+?)(?=\n|$)/g;
	const chapters: YouTubeChapter[] = [];

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
	while ((match = chapterRegex.exec(description)) !== null) {
		const hours = match[1] ? parseInt(match[1].replace(':', ''), 10) : 0;
		const minutes = parseInt(match[2], 10);
		const seconds = parseInt(match[3], 10);
		const title = match[4].trim();

		if (title.length < 2 || /^\d+:\d+/.test(title)) continue;

		const startTime = hours * 3600 + minutes * 60 + seconds;
		chapters.push({ title, startTime });
	}

	for (let i = 0; i < chapters.length - 1; i++) {
		chapters[i].endTime = chapters[i + 1].startTime;
	}

	return chapters.length >= 2 ? chapters : [];
}

const transcriptFetch: typeof fetch = (input, init) => {
	const timeout = AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS);
	return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

/**
 * ISO-8601 duration as the videos endpoint returns it: PT1H2M3S, PT58S, PT3M.
 * Null when there is no real length yet — a live stream or an unstarted premiere
 * reports `P0D`.
 */
function isoDurationSeconds(duration: string): number | null {
	const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration.trim());
	if (!match) throw new Error(`Unparseable YouTube duration: ${duration}`);
	const [, days, hours, minutes, seconds] = match;
	const total = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
	return total > 0 ? total : null;
}

function toSeconds(value: string | number | undefined, field: string, videoId: string): number {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number.parseFloat(value) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`YouTube transcript ${videoId} has invalid ${field}`);
	return parsed;
}

async function fetchYouTubeVideoData(videoId: string, youtubeApiKey: string): Promise<YouTubeVideosResponse> {
	const url = new URL('https://www.googleapis.com/youtube/v3/videos');
	url.searchParams.set('id', videoId);
	url.searchParams.set('part', 'snippet,contentDetails,statistics');
	url.searchParams.set('key', youtubeApiKey);

	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		return YouTubeVideosResponseSchema.parse(await response.json());
	} catch (error) {
		const message = String(error);
		throw new Error(
			`YouTube API request failed for ${videoId}: ${youtubeApiKey ? message.replaceAll(youtubeApiKey, '[redacted]') : message}`,
		);
	}
}

async function fetchYouTubeChannel(
	youtubeApiKey: string,
	lookup: { id: string } | { handle: string },
): Promise<{ id: string; title: string | null; avatarUrl: string | null } | null> {
	if (!youtubeApiKey) throw new Error('YouTube channel lookup is not configured');
	const url = new URL('https://www.googleapis.com/youtube/v3/channels');
	if ('id' in lookup) url.searchParams.set('id', lookup.id);
	else url.searchParams.set('forHandle', `@${lookup.handle.replace(/^@/, '')}`);
	url.searchParams.set('part', 'snippet');
	url.searchParams.set('key', youtubeApiKey);

	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const channelData = YouTubeChannelsResponseSchema.parse(await response.json());
		if (channelData.error) throw new Error(channelData.error.message);
		const channel = channelData.items?.[0];
		if (!channel) return null;
		return {
			id: channel.id,
			title: channel.snippet.title.trim() || null,
			avatarUrl: bestThumbnailUrl(channel.snippet.thumbnails),
		};
	} catch (error) {
		const message = String(error);
		throw new Error(`YouTube channel lookup failed: ${message.replaceAll(youtubeApiKey, '[redacted]')}`);
	}
}

async function fetchTranscript(videoId: string): Promise<Pick<YouTubeTranscript, 'segments' | 'language'>> {
	const { YoutubeTranscript } = await import('youtube-transcript');
	let items: TranscriptResponse[];
	try {
		items = await YoutubeTranscript.fetchTranscript(videoId, { fetch: transcriptFetch });
	} catch (error) {
		console.warn({
			tag: 'YOUTUBE',
			msg: 'Transcript unavailable; using video description',
			videoId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { segments: [], language: null };
	}

	if (!items?.length) {
		console.info({ tag: 'YOUTUBE', msg: 'Transcript unavailable; using video description', videoId });
		return { segments: [], language: null };
	}

	const segments: YouTubeTranscriptSegment[] = items.map((item) => {
		const startTime = toSeconds(item.offset, 'offset', videoId) / 1000;
		return {
			startTime,
			endTime: startTime + toSeconds(item.duration, 'duration', videoId) / 1000,
			text: item.text,
		};
	});
	const language = items.find((item) => item.lang?.trim())?.lang?.trim() || null;

	console.info({ tag: 'YOUTUBE', msg: 'Transcript fetched', provider: 'youtube-transcript', count: segments.length, language });
	return { segments, language };
}

async function scrapeYouTube(videoId: string, youtubeApiKey: string): Promise<YouTubeAcquisition> {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching video', videoId });

	const videoData = await fetchYouTubeVideoData(videoId, youtubeApiKey);

	if (videoData.error) throw new Error(`YouTube API: ${videoData.error.message}`);
	if (!videoData.items?.length) throw new NonRetryableError(`YouTube video ${videoId} was not found`);

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	const durationSeconds = isoDurationSeconds(video.contentDetails.duration);
	const thumbnailUrl = bestThumbnailUrl(snippet.thumbnails);
	const chapters = parseChaptersFromDescription(snippet.description);

	console.info({ tag: 'YOUTUBE', msg: 'Fetching transcript', videoId });
	const [channelAvatar, transcript] = await Promise.all([
		fetchYouTubeChannel(youtubeApiKey, { id: snippet.channelId })
			.then((channel) => channel?.avatarUrl ?? null)
			.catch((error) => {
				console.warn({
					tag: 'YOUTUBE',
					msg: 'Channel avatar unavailable',
					channelId: snippet.channelId,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}),
		fetchTranscript(videoId),
	]);
	const creators = literalCreator('channel', snippet.channelTitle, {
		...(channelAvatar?.trim() ? { avatarUrl: channelAvatar.trim() } : {}),
		...(snippet.channelId.trim() ? { profileUrl: `https://www.youtube.com/channel/${encodeURIComponent(snippet.channelId.trim())}` } : {}),
	});

	console.info({ tag: 'YOUTUBE', msg: 'Video fetched', title: snippet.title });

	return {
		resourcePlatform: 'youtube',
		platformId: videoId,
		fileType: null,
		title: snippet.title,
		markdown:
			transcript.segments
				.map((segment) => segment.text.trim())
				.filter(Boolean)
				.join('\n') || snippet.description.trim(),
		summary: snippet.description.substring(0, 500) || null,
		source: snippet.channelTitle.trim() || 'YouTube',
		originalLang: transcript.language ?? snippet.defaultAudioLanguage ?? null,
		publishedDate: snippet.publishedAt,
		creators,
		kindMetadata: {
			...(durationSeconds === null ? {} : { durationSeconds }),
			...(stats.viewCount ? { viewCount: Number.parseInt(stats.viewCount, 10) } : {}),
			...(stats.likeCount ? { likeCount: Number.parseInt(stats.likeCount, 10) } : {}),
			...(stats.commentCount ? { commentCount: Number.parseInt(stats.commentCount, 10) } : {}),
		},
		previewImageUrl: thumbnailUrl,
		transcript: {
			segments: transcript.segments,
			language: transcript.language ?? snippet.defaultAudioLanguage ?? null,
			chapters,
			chaptersFromDescription: chapters.length > 0,
		},
	};
}

export async function stageYouTubeAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		hints: ResourceAcquisitionHints;
		processingId: string;
		videoId: string;
	},
): Promise<YouTubeResolvedResource> {
	const contentStream = await step.do(
		'acquire-youtube-v1',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await scrapeYouTube(input.videoId, env.YOUTUBE_API_KEY)).body!,
	);
	const acquired = await new Response(contentStream).json<YouTubeAcquisition>();
	const { transcript, ...material } = acquired;
	const highlights = transcript.segments.length
		? await step
				.do(
					'prepare-youtube-highlights-v2',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
					() => prepareYouTubeHighlightsFromTranscript(env, input.processingId, input.videoId, transcript.segments),
				)
				.catch((error) => {
					console.error({
						tag: 'YOUTUBE',
						msg: 'Optional YouTube highlights failed after retries',
						processing_id: input.processingId,
						error: error instanceof Error ? error.message : String(error),
					});
					return null;
				})
		: null;
	return {
		...materializePlatformResource(material, input.hints, { kind: 'video', url: `https://youtube.com/watch?v=${input.videoId}` }),
		youtube: { transcript, highlights },
	};
}

const YouTubeHighlightSchema = z
	.object({
		title: z.string().min(1),
		summary: z.string().min(1),
		startTime: z.number().nonnegative(),
		endTime: z.number().nonnegative(),
	})
	.refine(({ startTime, endTime }) => endTime > startTime, { message: 'Highlight endTime must be after startTime' });
const YouTubeHighlightsSchema = z.object({ highlights: z.array(YouTubeHighlightSchema).min(5).max(8) });
const YOUTUBE_HIGHLIGHTS_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const HIGHLIGHTS_SYSTEM_PROMPT = `你是專業的影片內容分析師。分析 YouTube 影片逐字稿，找出 5-8 個最重要的主題段落。

規則：
1. 每個段落代表一個獨立主題
2. 段落之間不重疊
3. 標題要精簡有力（30字內）
4. 時間戳記要準確對應討論內容的起止
5. 所有文字使用繁體中文

只回傳符合 schema 的資料。`;

async function prepareYouTubeHighlightsFromTranscript(
	env: CoreEnv,
	processingId: string,
	videoId: string,
	transcript: YouTubeTranscriptSegment[],
): Promise<YouTubeHighlights> {
	console.info({ tag: 'AI', msg: 'Generating YouTube highlights', videoId });

	const transcriptText = transcript.map((segment) => `[${Math.floor(segment.startTime)}s] ${segment.text}`).join('\n');
	const last = transcript[transcript.length - 1];
	const duration = Math.ceil(last.endTime);
	const { finishReason, output: highlights } = await generateText({
		model: createWorkersAI({ binding: env.AI })(YOUTUBE_HIGHLIGHTS_MODEL, {
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'youtube-highlights',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					processing_id: processingId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt: `影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`,
		system: HIGHLIGHTS_SYSTEM_PROMPT,
		output: Output.object({ schema: YouTubeHighlightsSchema }),
		maxOutputTokens: 2000,
		temperature: 0.3,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error(`YouTube highlights hit the output token cap for ${videoId}`);
	if (!highlights?.highlights.length) throw new Error(`YouTube highlights did not return valid output for ${videoId}`);

	console.info({ tag: 'AI', msg: 'YouTube highlights generated', videoId, count: highlights.highlights.length });
	return {
		version: '1.0',
		model: YOUTUBE_HIGHLIGHTS_MODEL,
		highlights: highlights.highlights,
		generatedAt: new Date().toISOString(),
	};
}
