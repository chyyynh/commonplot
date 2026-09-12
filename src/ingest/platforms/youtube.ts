import { generateText, Output } from 'ai';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { createWorkersAI } from 'workers-ai-provider';
import type { TranscriptResponse } from 'youtube-transcript';
import { z } from 'zod';
import { type AcquiredResource, type ResourceAcquisitionHints, resolveResourceHints } from '../../shared/resource';
import { coreGatewayOptions, CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from '../ai-model';

const TRANSCRIPT_FETCH_TIMEOUT_MS = 8_000;
const YOUTUBE_API_TIMEOUT_MS = 15_000;

type YouTubeTranscriptSegment = Readonly<{ startTime: number; endTime: number; text: string }>;
type YouTubeChapter = { title: string; startTime: number; endTime?: number };
type YouTubeTranscript = Readonly<{
	segments: YouTubeTranscriptSegment[];
	language: string | null;
	chapters: YouTubeChapter[];
}>;
type YouTubeHighlights = z.infer<typeof YouTubeHighlightsSchema> &
	Readonly<{
		version: '1.0';
		model: string;
		generatedAt: string;
	}>;
export type YouTubeResourceData = Readonly<{
	transcript: YouTubeTranscript;
	highlights: YouTubeHighlights | null;
}>;

const YouTubeThumbnailSchema = z.object({ url: z.string().min(1) });
const YouTubeThumbnailsSchema = z.object({
	default: YouTubeThumbnailSchema.optional(),
	medium: YouTubeThumbnailSchema.optional(),
	high: YouTubeThumbnailSchema.optional(),
	standard: YouTubeThumbnailSchema.optional(),
	maxres: YouTubeThumbnailSchema.optional(),
});
const YouTubeCountSchema = z.string().regex(/^\d+$/).transform(Number);
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
				snippet: z.object({
					thumbnails: YouTubeThumbnailsSchema,
				}),
			}),
		)
		.optional(),
	error: YouTubeApiErrorSchema.optional(),
});
type YouTubeThumbnails = z.infer<typeof YouTubeThumbnailsSchema>;
type YouTubeAcquisition = Awaited<ReturnType<typeof scrapeYouTube>>;

function bestThumbnailUrl(thumbnails: YouTubeThumbnails): string | null {
	return (
		thumbnails.maxres?.url ?? thumbnails.standard?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null
	);
}

function parseChaptersFromDescription(description: string): YouTubeChapter[] {
	const chapterRegex = /(?:^|\n)(\d{1,2}:)?(\d{1,2}):(\d{2})\s+(.+?)(?=\n|$)/g;
	const chapters: YouTubeChapter[] = [];

	for (const [, hours, minutes, seconds, chapterTitle] of description.matchAll(chapterRegex)) {
		const title = chapterTitle.trim();

		if (title.length < 2 || /^\d+:\d+/.test(title)) continue;

		const startTime = Number.parseInt(hours ?? '0', 10) * 3600 + Number(minutes) * 60 + Number(seconds);
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

async function fetchYouTubeVideoData(videoId: string, youtubeApiKey: string) {
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

async function fetchChannelAvatar(youtubeApiKey: string, channelId: string): Promise<string | null> {
	const url = new URL('https://www.googleapis.com/youtube/v3/channels');
	url.searchParams.set('id', channelId);
	url.searchParams.set('part', 'snippet');
	url.searchParams.set('key', youtubeApiKey);

	try {
		if (!youtubeApiKey) throw new Error('YouTube channel lookup is not configured');
		const response = await fetch(url, { signal: AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const channelData = YouTubeChannelsResponseSchema.parse(await response.json());
		if (channelData.error) throw new Error(channelData.error.message);
		const channel = channelData.items?.[0];
		return channel ? bestThumbnailUrl(channel.snippet.thumbnails) : null;
	} catch (error) {
		const message = String(error);
		console.warn({
			tag: 'YOUTUBE',
			msg: 'Channel avatar unavailable',
			channelId,
			error: youtubeApiKey ? message.replaceAll(youtubeApiKey, '[redacted]') : message,
		});
		return null;
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

async function scrapeYouTube(videoId: string, youtubeApiKey: string, hints: ResourceAcquisitionHints) {
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
	const [channelAvatar, transcript] = await Promise.all([fetchChannelAvatar(youtubeApiKey, snippet.channelId), fetchTranscript(videoId)]);
	const channelTitle = snippet.channelTitle.trim();

	console.info({ tag: 'YOUTUBE', msg: 'Video fetched', title: snippet.title });

	return {
		kind: 'video',
		resourcePlatform: 'youtube',
		resourceIdentifiers: [{ preferred: true, scheme: 'youtube', value: videoId }],
		url: `https://youtube.com/watch?v=${videoId}`,
		fileType: null,
		title: snippet.title.trim(),
		content:
			transcript.segments
				.map((segment) => segment.text.trim())
				.filter(Boolean)
				.join('\n') || snippet.description.trim(),
		source: channelTitle || 'YouTube',
		...resolveResourceHints(
			{
				originalLang: transcript.language ?? snippet.defaultAudioLanguage ?? null,
				publishedDate: snippet.publishedAt,
				summary: snippet.description,
			},
			hints,
		),
		creators: channelTitle
			? [
					{
						role: 'channel',
						literal: channelTitle,
						...(channelAvatar?.trim() ? { avatarUrl: channelAvatar.trim() } : {}),
						...(snippet.channelId.trim()
							? { profileUrl: `https://www.youtube.com/channel/${encodeURIComponent(snippet.channelId.trim())}` }
							: {}),
					},
				]
			: [],
		kindMetadata: {
			...(durationSeconds === null ? {} : { durationSeconds }),
			...stats,
		},
		previewImageUrl: thumbnailUrl?.trim() || null,
		subject: null,
		youtube: {
			transcript: { ...transcript, language: transcript.language ?? snippet.defaultAudioLanguage ?? null, chapters },
			highlights: null,
		},
	} satisfies AcquiredResource & { youtube: YouTubeResourceData };
}

export async function stageYouTubeAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		hints: ResourceAcquisitionHints;
		processingId: string;
		videoId: string;
	},
) {
	const contentStream = await step.do(
		'acquire-youtube-v2',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => Response.json(await scrapeYouTube(input.videoId, env.YOUTUBE_API_KEY, input.hints)).body!,
	);
	const acquired = await new Response(contentStream).json<YouTubeAcquisition>();
	const { transcript } = acquired.youtube;
	const highlights =
		transcript.segments.length && transcript.chapters.length === 0
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
	return { ...acquired, youtube: { transcript, highlights } };
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
		model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
			...CORE_STRUCTURED_MODEL_SETTINGS,
			...coreGatewayOptions(env, { feature: 'youtube-highlights', processing_id: processingId }),
		}),
		prompt: `影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`,
		system: HIGHLIGHTS_SYSTEM_PROMPT,
		output: Output.object({ name: 'youtube_highlights', schema: YouTubeHighlightsSchema }),
		maxOutputTokens: 2000,
		temperature: 0.3,
		reasoning: 'none',
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error(`YouTube highlights hit the output token cap for ${videoId}`);
	if (!highlights?.highlights.length) throw new Error(`YouTube highlights did not return valid output for ${videoId}`);

	console.info({ tag: 'AI', msg: 'YouTube highlights generated', videoId, count: highlights.highlights.length });
	return {
		version: '1.0',
		model: CORE_TEXT_MODEL,
		highlights: highlights.highlights,
		generatedAt: new Date().toISOString(),
	};
}
