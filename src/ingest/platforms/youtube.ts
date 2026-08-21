import type { ResourceForProcessing, TranscriptSegment, YouTubeHighlights, YoutubeTranscript } from '@core-shared/types';
import { withCoreDb } from '@db/client';
import { youtubeTranscripts } from '@db/schema';
import { generateText, Output } from 'ai';
import { eq } from 'drizzle-orm';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

// Enrichment only. Channel discovery is the feed monitor's job: a channel handle
// is its Atom feed URL, so channels stay platform='youtube' with content_mode
// 'web' and are polled by handleRSSCron, and scrapeSavedUrl routes the resulting
// watch?v= links back to YouTube.

const YouTubeHighlightSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	startTime: z.number().nonnegative(),
	endTime: z.number().nonnegative(),
});

export interface YouTubeHighlightsUpdate {
	videoId: string;
	value: YouTubeHighlights;
}

const HIGHLIGHTS_SYSTEM_PROMPT = `你是專業的影片內容分析師。分析 YouTube 影片逐字稿，找出 5-8 個最重要的主題段落。

規則：
1. 每個段落代表一個獨立主題
2. 段落之間不重疊
3. 標題要精簡有力（30字內）
4. 時間戳記要準確對應討論內容的起止
5. 所有文字使用繁體中文

只回傳符合 schema 的資料。`;

const YouTubeHighlightsSchema = z.object({
	highlights: z.array(YouTubeHighlightSchema).min(1),
});
const YOUTUBE_HIGHLIGHTS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export async function prepareYouTubeHighlights(
	env: CoreEnv,
	resource: ResourceForProcessing,
	videoId: string,
	transcript?: YoutubeTranscript | null,
): Promise<YouTubeHighlightsUpdate | null> {
	if (resource.resource_platform !== 'youtube') return null;
	if (transcript) {
		return transcript.segments.length ? prepareYouTubeHighlightsFromTranscript(env, resource.id, videoId, transcript.segments) : null;
	}

	const row = await withCoreDb(
		env,
		async (db) =>
			(
				await db
					.select({ transcript: youtubeTranscripts.transcript, aiHighlights: youtubeTranscripts.aiHighlights })
					.from(youtubeTranscripts)
					.where(eq(youtubeTranscripts.videoId, videoId))
					.limit(1)
			)[0],
	);
	if (!row || row.aiHighlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return null;

	return prepareYouTubeHighlightsFromTranscript(env, resource.id, videoId, row.transcript);
}

async function prepareYouTubeHighlightsFromTranscript(
	env: CoreEnv,
	resourceId: string,
	videoId: string,
	transcript: TranscriptSegment[],
): Promise<YouTubeHighlightsUpdate | null> {
	console.info({ tag: 'AI', msg: 'Generating YouTube highlights', videoId });

	const transcriptText = transcript.map((s) => `[${Math.floor(s.startTime)}s] ${s.text}`).join('\n');
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

	if (!highlights?.highlights.length) {
		throw new Error(`YouTube highlights did not return valid output for ${videoId}`);
	}

	console.info({ tag: 'AI', msg: 'YouTube highlights generated', videoId, count: highlights.highlights.length });
	const generatedAt = new Date().toISOString();
	return {
		videoId,
		value: {
			version: '1.0',
			model: YOUTUBE_HIGHLIGHTS_MODEL,
			highlights: highlights.highlights,
			generatedAt,
		},
	};
}
