import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import { literalCreator } from '@core-shared/resource-metadata';
import type {
	AcquiredMaterial,
	TranscriptSegment,
	YouTubeChapter,
	YouTubeHighlights,
	YouTubeResourceSpecialization,
	YoutubeTranscript,
} from '@core-shared/types';
import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { acquisitionResultArtifact, DEFAULT_ACQUISITION_STEP_CONFIG, normalizeAcquiredContent } from '../acquired-content';

const TRANSCRIPT_FETCH_TIMEOUT_MS = 8_000;
const YOUTUBE_API_TIMEOUT_MS = 15_000;
const YOUTUBE_API_MAX_BYTES = 1024 * 1024;
const MIN_MONITORED_VIDEO_DURATION_SECONDS = 180;
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
				snippet: z.object({ thumbnails: YouTubeThumbnailsSchema }),
			}),
		)
		.optional(),
	error: YouTubeApiErrorSchema.optional(),
});
export const YouTubeTranscriptSchema: z.ZodType<YoutubeTranscript> = z.object({
	videoId: z.string().min(1),
	segments: z.array(z.object({ startTime: z.number(), endTime: z.number(), text: z.string() })),
	language: z.string().nullable(),
	chapters: z.array(z.object({ title: z.string(), startTime: z.number(), endTime: z.number().optional() })),
	chaptersFromDescription: z.boolean(),
});

type YouTubeThumbnails = z.infer<typeof YouTubeThumbnailsSchema>;
type YouTubeVideosResponse = z.infer<typeof YouTubeVideosResponseSchema>;

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
	const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
	return fetchWithTimeout(url, init, TRANSCRIPT_FETCH_TIMEOUT_MS);
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
		const response = await fetchWithTimeout(url.toString(), undefined, YOUTUBE_API_TIMEOUT_MS);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		return YouTubeVideosResponseSchema.parse(JSON.parse(await readTextWithLimit(response, YOUTUBE_API_MAX_BYTES)));
	} catch (error) {
		const message = String(error);
		throw new Error(
			`YouTube API request failed for ${videoId}: ${youtubeApiKey ? message.replaceAll(youtubeApiKey, '[redacted]') : message}`,
		);
	}
}

async function fetchYouTubeChannelAvatar(channelId: string, youtubeApiKey: string): Promise<string | null> {
	const url = new URL('https://www.googleapis.com/youtube/v3/channels');
	url.searchParams.set('id', channelId);
	url.searchParams.set('part', 'snippet');
	url.searchParams.set('key', youtubeApiKey);

	try {
		const response = await fetchWithTimeout(url.toString(), undefined, YOUTUBE_API_TIMEOUT_MS);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const channelData = YouTubeChannelsResponseSchema.parse(JSON.parse(await readTextWithLimit(response, YOUTUBE_API_MAX_BYTES)));
		if (channelData.error) throw new Error(channelData.error.message);
		if (!channelData.items?.length) throw new Error('Channel not found');
		return bestThumbnailUrl(channelData.items[0].snippet.thumbnails);
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

async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
	const { YoutubeTranscript } = await import('youtube-transcript');
	let items: Array<{ offset: number; duration: number; text: string }>;
	try {
		items = await YoutubeTranscript.fetchTranscript(videoId, { fetch: transcriptFetch });
	} catch (error) {
		console.warn({
			tag: 'YOUTUBE',
			msg: 'Transcript unavailable; using video description',
			videoId,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}

	if (!items?.length) {
		console.info({ tag: 'YOUTUBE', msg: 'Transcript unavailable; using video description', videoId });
		return [];
	}

	const segments: TranscriptSegment[] = items.map((item: { offset: number; duration: number; text: string }) => {
		const startTime = toSeconds(item.offset, 'offset', videoId) / 1000;
		return {
			startTime,
			endTime: startTime + toSeconds(item.duration, 'duration', videoId) / 1000,
			text: item.text,
		};
	});

	console.info({ tag: 'YOUTUBE', msg: 'Transcript fetched', provider: 'youtube-transcript', count: segments.length });
	return segments;
}

async function scrapeYouTube(
	videoId: string,
	youtubeApiKey: string,
	monitoredOnly: boolean,
	sourceAvatarUrl: string | null,
): Promise<AcquiredMaterial<'youtube'>> {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching video', videoId });

	const videoData = await fetchYouTubeVideoData(videoId, youtubeApiKey);

	if (videoData.error) throw new Error(`YouTube API: ${videoData.error.message}`);
	if (!videoData.items?.length) throw new NonRetryableError(`YouTube video ${videoId} was not found`);

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	const durationSeconds = isoDurationSeconds(video.contentDetails.duration);
	if (monitoredOnly && (durationSeconds === null || durationSeconds <= MIN_MONITORED_VIDEO_DURATION_SECONDS)) {
		const reason = durationSeconds === null ? 'is a live stream or unstarted premiere' : `runs ${durationSeconds}s`;
		throw new NonRetryableError(
			`YouTube video ${videoId} ${reason}; monitored videos must exceed ${MIN_MONITORED_VIDEO_DURATION_SECONDS}s`,
		);
	}

	const thumbnailUrl = bestThumbnailUrl(snippet.thumbnails);
	const chapters = parseChaptersFromDescription(snippet.description);

	console.info({ tag: 'YOUTUBE', msg: 'Fetching transcript', videoId });
	const [channelAvatar, transcript] = await Promise.all([
		sourceAvatarUrl ?? fetchYouTubeChannelAvatar(snippet.channelId, youtubeApiKey),
		fetchTranscript(videoId),
	]);
	const transcriptMarkdown = transcript
		.map((segment) => segment.text.trim())
		.filter(Boolean)
		.join('\n');
	const content = transcriptMarkdown || snippet.description.trim();
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
		markdown: content,
		source: snippet.channelTitle.trim() || 'YouTube',
		originalLang: snippet.defaultAudioLanguage ?? null,
		publishedDate: snippet.publishedAt,
		summary: snippet.description.substring(0, 500) || null,
		creators,
		kindMetadata: {
			...(durationSeconds === null ? {} : { durationSeconds }),
			...(stats.viewCount ? { viewCount: Number.parseInt(stats.viewCount, 10) } : {}),
			...(stats.likeCount ? { likeCount: Number.parseInt(stats.likeCount, 10) } : {}),
			...(stats.commentCount ? { commentCount: Number.parseInt(stats.commentCount, 10) } : {}),
		},
		previewImageUrl: thumbnailUrl,
		youtubeTranscript: {
			videoId: video.id,
			segments: transcript,
			language: snippet.defaultAudioLanguage ?? null,
			chapters,
			chaptersFromDescription: chapters.length > 0,
		},
	};
}

export function stageYouTubeAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	input: { monitoredOnly: boolean; route: number; sourceAvatarUrl: string | null; url: string; videoId: string },
): Promise<ReadableStream<Uint8Array>> {
	return step.do(`acquire-youtube-v1-${input.route}`, DEFAULT_ACQUISITION_STEP_CONFIG, () =>
		acquisitionResultArtifact(async () =>
			normalizeAcquiredContent({
				...(await scrapeYouTube(input.videoId, env.YOUTUBE_API_KEY, input.monitoredOnly, input.sourceAvatarUrl)),
				canonicalUrl: input.url,
			}),
		),
	);
}

const YouTubeHighlightSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	startTime: z.number().nonnegative(),
	endTime: z.number().nonnegative(),
});
const YouTubeHighlightsSchema = z.object({ highlights: z.array(YouTubeHighlightSchema).min(1) });
const YOUTUBE_HIGHLIGHTS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const HIGHLIGHTS_SYSTEM_PROMPT = `你是專業的影片內容分析師。分析 YouTube 影片逐字稿，找出 5-8 個最重要的主題段落。

規則：
1. 每個段落代表一個獨立主題
2. 段落之間不重疊
3. 標題要精簡有力（30字內）
4. 時間戳記要準確對應討論內容的起止
5. 所有文字使用繁體中文

只回傳符合 schema 的資料。`;

export async function stageYouTubeEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	acquired: AcquiredMaterial<'youtube'>,
	processingId: string,
): Promise<YouTubeResourceSpecialization> {
	const transcript = acquired.youtubeTranscript;
	const videoId = acquired.platformId;
	const highlights = transcript.segments.length
		? await step
				.do(
					'prepare-youtube-highlights-v2',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
					() => prepareYouTubeHighlightsFromTranscript(env, processingId, videoId, transcript.segments),
				)
				.catch((error) => {
					console.error({
						tag: 'YOUTUBE',
						msg: 'Optional YouTube highlights failed after retries',
						processing_id: processingId,
						error: error instanceof Error ? error.message : String(error),
					});
					return null;
				})
		: null;
	return {
		kind: 'youtube',
		transcript: {
			segments: transcript.segments,
			language: transcript.language,
			chapters: transcript.chapters,
			chaptersFromDescription: transcript.chaptersFromDescription,
		},
		highlights,
	};
}

async function prepareYouTubeHighlightsFromTranscript(
	env: CoreEnv,
	resourceId: string,
	videoId: string,
	transcript: TranscriptSegment[],
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
					resource_id: resourceId,
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
