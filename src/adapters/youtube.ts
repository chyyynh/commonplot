import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import type { AcquiredResource, YouTubeChapter, YouTubeTranscript } from '../contracts/acquired-resource';
import { fetchYouTubeCaptions, type YouTubeCaptions } from '../services/youtube-captions';
import { buildTranscriptLines, transcriptMarkdown } from './youtube-transcript';

const YOUTUBE_API_TIMEOUT_MS = 15_000;

const YouTubeThumbnailSchema = z.object({ url: z.string().min(1) });
const YouTubeThumbnailsSchema = z.object({
	default: YouTubeThumbnailSchema.optional(),
	medium: YouTubeThumbnailSchema.optional(),
	high: YouTubeThumbnailSchema.optional(),
	standard: YouTubeThumbnailSchema.optional(),
	maxres: YouTubeThumbnailSchema.optional(),
});
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
});
const YouTubeVideosResponseSchema = z.object({
	items: z.array(YouTubeVideoItemSchema).optional(),
});
const YouTubeChannelsResponseSchema = z.object({
	items: z
		.array(
			z.object({
				id: z.string().min(1),
				snippet: z.object({
					thumbnails: YouTubeThumbnailsSchema,
				}),
			}),
		)
		.optional(),
});
type YouTubeThumbnails = z.infer<typeof YouTubeThumbnailsSchema>;

function bestThumbnailUrl(thumbnails: YouTubeThumbnails): string | null {
	return (
		thumbnails.maxres?.url ?? thumbnails.standard?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null
	);
}

function parseChaptersFromDescription(description: string): YouTubeChapter[] {
	// `0:00 Intro`, `[00:00:00] — Intro`, `(1:02:03) Intro`
	const chapterRegex = /(?:^|\n)[ \t]*[[(]?(\d{1,2}:)?(\d{1,2}):(\d{2})[\])]?[ \t]+(.+?)(?=\n|$)/g;
	const chapters: YouTubeChapter[] = [];

	for (const [, hours, minutes, seconds, chapterTitle] of description.matchAll(chapterRegex)) {
		const title = chapterTitle.trim();

		if (title.length < 2 || /^\d+:\d+/.test(title)) continue;

		const startTime = Number.parseInt(hours ?? '0', 10) * 3600 + Number(minutes) * 60 + Number(seconds);
		chapters.push({ title: title.replace(/^[\s\u2022\u00b7*\u2013\u2014-]+/, '').trim() || title, startTime });
	}

	for (let i = 0; i < chapters.length - 1; i++) {
		if (chapters[i].startTime >= chapters[i + 1].startTime) return [];
		chapters[i].endTime = chapters[i + 1].startTime;
	}

	return chapters.length >= 2 ? chapters : [];
}

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

async function fetchYouTubeVideoData(videoId: string, youtubeApiKey: string) {
	const url = new URL('https://www.googleapis.com/youtube/v3/videos');
	url.searchParams.set('id', videoId);
	url.searchParams.set('part', 'snippet,contentDetails');
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
		const channel = channelData.items?.find((item) => item.id === channelId);
		if (channelData.items?.length && !channel) throw new Error('YouTube API returned no matching channel');
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

async function scrapeYouTubeVideo(videoId: string, youtubeApiKey: string) {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching video', videoId });

	const videoData = await fetchYouTubeVideoData(videoId, youtubeApiKey);

	if (!videoData.items?.length) throw new NonRetryableError(`YouTube video ${videoId} was not found`);

	const video = videoData.items.find((item) => item.id === videoId);
	if (!video) throw new Error(`YouTube API returned no matching video for ${videoId}`);
	const snippet = video.snippet;

	const durationSeconds = isoDurationSeconds(video.contentDetails.duration);
	const thumbnailUrl = bestThumbnailUrl(snippet.thumbnails);
	const chapters = parseChaptersFromDescription(snippet.description);

	const channelAvatar = await fetchChannelAvatar(youtubeApiKey, snippet.channelId);
	const channelTitle = snippet.channelTitle.trim();

	console.info({ tag: 'YOUTUBE', msg: 'Video fetched', title: snippet.title });

	return {
		kind: 'video',
		resourcePlatform: 'youtube',
		resourceIdentifiers: [{ preferred: true, scheme: 'youtube', value: videoId }],
		url: `https://youtube.com/watch?v=${videoId}`,
		fileType: null,
		title: snippet.title.trim(),
		source: channelTitle || 'YouTube',
		audioLanguage: snippet.defaultAudioLanguage ?? null,
		publishedDate: snippet.publishedAt,
		summary: snippet.description,
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
		kindMetadata: durationSeconds === null ? {} : { durationSeconds },
		previewImageUrl: thumbnailUrl?.trim() || null,
		subjectUrl: null,
		chapters,
	} satisfies Omit<AcquiredResource, 'content' | 'originalLang'> & { audioLanguage: string | null; chapters: YouTubeChapter[] };
}

type YouTubeVideo = Awaited<ReturnType<typeof scrapeYouTubeVideo>>;

export async function stageYouTubeAcquisition(env: CoreEnv, step: WorkflowStep, videoId: string) {
	const { audioLanguage, chapters, ...video } = await step.do(
		'acquire-youtube-video-v1',
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
		async (): Promise<YouTubeVideo> => scrapeYouTubeVideo(videoId, env.YOUTUBE_API_KEY),
	);
	const captions = await step
		.do(
			'acquire-youtube-captions-v2',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			// Long videos exceed the step result limit as JSON values; stream them.
			async () => Response.json(await fetchYouTubeCaptions(env, videoId, audioLanguage)).body!,
		)
		.then((body) => new Response(body).json<YouTubeCaptions>());
	const lines = buildTranscriptLines(captions.cues);
	return {
		...video,
		content: lines.length ? transcriptMarkdown(lines) : video.summary.trim(),
		originalLang: captions.language ?? audioLanguage ?? 'und',
		youtube: { lines, chapters },
	} satisfies AcquiredResource & { youtube: YouTubeTranscript };
}
