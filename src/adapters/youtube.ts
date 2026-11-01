import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import type { PlatformResource, YouTubeChapter, YouTubeTranscript } from '../contracts/acquired-resource';
import { paragraphsMarkdown } from '../contracts/markdown';
import { FETCH_STEP_RETRIES, stepJson } from '../services/workflow-step';
import { buildTranscriptLines, fetchYouTubeCaptions } from '../services/youtube-captions';

const YOUTUBE_API_TIMEOUT_MS = 15_000;

const THUMBNAIL_SIZES = ['fhd', 'maxres', 'standard', 'high', 'medium', 'default'] as const;
const THUMBNAIL_CHECK_TIMEOUT_MS = 5_000;
/**
 * Thumbnails parse to their URLs, largest known size first. YouTube adds sizes
 * without notice (`fhd` arrived in 2026), so an unknown key is ignored, not an error.
 */
const YouTubeThumbnailsSchema = z
	.record(z.string(), z.unknown())
	.transform((thumbnails) =>
		THUMBNAIL_SIZES.flatMap((size) => z.object({ url: z.string().trim().min(1) }).safeParse(thumbnails[size]).data?.url ?? []),
	);
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

	// YouTube's own rule: chapters start at 0:00, ascend, and number at least three. A later list in the description,
	// such as a tracklist or a guest's timestamps, ends the run instead of discarding it.
	const start = chapters.findIndex(({ startTime }) => startTime === 0);
	if (start < 0) return [];
	const run = [chapters[start]];
	for (const chapter of chapters.slice(start + 1)) {
		const previous = run[run.length - 1];
		if (chapter.startTime <= previous.startTime) break;
		previous.endTime = chapter.startTime;
		run.push(chapter);
	}
	return run.length >= 3 ? run : [];
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

/** One YouTube Data API listing, parsed by `schema`; its errors never carry the API key the request URL holds. */
async function fetchYouTubeApi<Schema extends z.ZodType>(
	resource: 'videos' | 'channels',
	id: string,
	part: string,
	youtubeApiKey: string,
	schema: Schema,
) {
	try {
		const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
		url.search = new URLSearchParams({ id, part, key: youtubeApiKey }).toString();
		const response = await fetch(url, { signal: AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS) });
		if (!response.ok) {
			// Google names the cause (keyInvalid, quotaExceeded, …) only in the body.
			const body = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${body.slice(0, 300) || response.statusText}`);
		}
		return schema.parse(await response.json()) as z.output<Schema>;
	} catch (error) {
		const message = String(error);
		throw new Error(
			`YouTube API ${resource} request failed for ${id}: ${youtubeApiKey ? message.replaceAll(youtubeApiKey, '[redacted]') : message}`,
		);
	}
}

async function fetchChannelAvatar(youtubeApiKey: string, channelId: string): Promise<string | null> {
	try {
		const channelData = await fetchYouTubeApi('channels', channelId, 'snippet', youtubeApiKey, YouTubeChannelsResponseSchema);
		const channel = channelData.items?.find((item) => item.id === channelId);
		if (channelData.items?.length && !channel) throw new Error('YouTube API returned no matching channel');
		return channel?.snippet.thumbnails[0] ?? null;
	} catch (error) {
		console.warn({ tag: 'YOUTUBE', msg: 'Channel avatar unavailable', channelId, error: String(error) });
		return null;
	}
}

/**
 * The first thumbnail that serves. A video's thumbnail URLs carry a `?v=` version that
 * 404s until YouTube publishes that version (a new upload, a replaced thumbnail), while
 * the same path without it serves the current one; a size can also be listed but missing.
 */
async function servedThumbnail(urls: readonly string[]): Promise<string | null> {
	const candidates = [...new Set(urls.flatMap((url) => [url, url.split('?')[0]!]))];
	for (const url of candidates) {
		const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(THUMBNAIL_CHECK_TIMEOUT_MS) }).catch(() => null);
		if (response?.ok) return url;
	}
	console.warn({ tag: 'YOUTUBE', msg: 'No thumbnail served', candidates: candidates.length });
	return null;
}

async function scrapeYouTubeVideo(videoId: string, youtubeApiKey: string) {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching video', videoId });

	const videoData = await fetchYouTubeApi('videos', videoId, 'snippet,contentDetails', youtubeApiKey, YouTubeVideosResponseSchema);

	if (!videoData.items?.length) throw new NonRetryableError(`YouTube video ${videoId} was not found`);

	const video = videoData.items.find((item) => item.id === videoId);
	if (!video) throw new Error(`YouTube API returned no matching video for ${videoId}`);
	const snippet = video.snippet;

	const durationSeconds = isoDurationSeconds(video.contentDetails.duration);
	const chapters = parseChaptersFromDescription(snippet.description);

	const channelAvatar = await fetchChannelAvatar(youtubeApiKey, snippet.channelId);
	const channelTitle = snippet.channelTitle.trim();

	console.info({ tag: 'YOUTUBE', msg: 'Video fetched', title: snippet.title });

	return {
		kind: 'video',
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
						profileUrl: `https://www.youtube.com/channel/${encodeURIComponent(snippet.channelId)}`,
						account: { platform: 'youtube' as const, id: snippet.channelId },
					},
				]
			: [],
		kindMetadata: durationSeconds === null ? {} : { durationSeconds },
		previewImageUrl: await servedThumbnail(snippet.thumbnails),
		subjectUrl: null,
		chapters,
	} satisfies Omit<PlatformResource, 'content'> & { audioLanguage: string | null; chapters: YouTubeChapter[] };
}

type YouTubeVideo = Awaited<ReturnType<typeof scrapeYouTubeVideo>>;

export async function stageYouTubeAcquisition(env: CoreEnv, step: WorkflowStep, videoId: string) {
	const { audioLanguage, chapters, ...video } = await step.do(
		'acquire-youtube-video-v1',
		{ retries: FETCH_STEP_RETRIES, timeout: '60 seconds' },
		async (): Promise<YouTubeVideo> => scrapeYouTubeVideo(videoId, env.YOUTUBE_API_KEY),
	);
	// Long videos exceed the step result limit as JSON values.
	const captions = await stepJson(
		step,
		'acquire-youtube-captions-v2',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => fetchYouTubeCaptions(videoId, audioLanguage),
	);
	const lines = captions && buildTranscriptLines(captions.cues);
	return {
		...video,
		// One Markdown paragraph per line, so the translation alignment path `[i]` pairs line `i` with its translation.
		content: lines?.length ? paragraphsMarkdown(lines.map((line) => line.text)) : video.summary.trim(),
		youtube: { lines, chapters },
	} satisfies PlatformResource & { youtube: YouTubeTranscript };
}
