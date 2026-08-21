import type { WorkflowStep } from 'cloudflare:workers';
import type { YouTubeSpecializationMutation } from '@app-domain/resource-graph-contracts';
import type { ResourceForProcessing, TranscriptSegment, YouTubeHighlights, YoutubeTranscript } from '@core-shared/types';
import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

// Enrichment only. Channel discovery is the feed monitor's job: a channel handle
// is its Atom feed URL, so channels stay platform='youtube' and are polled by
// handleRSSCron, while scrapeSavedUrl routes the resulting
// watch?v= links back to YouTube.

const YouTubeHighlightSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	startTime: z.number().nonnegative(),
	endTime: z.number().nonnegative(),
});

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

export async function stageYouTubeEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	transcript: YoutubeTranscript,
): Promise<YouTubeSpecializationMutation> {
	const videoId = resource.resource_identifiers.find((identifier) => identifier.scheme === 'youtube')?.value;
	if (!videoId) throw new Error(`YouTube processing ${resource.processing_id} has no exact video identifier`);
	const highlights = transcript.segments.length
		? await step
				.do(
					'prepare-youtube-highlights-v2',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
					() => prepareYouTubeHighlightsFromTranscript(env, resource.processing_id, videoId, transcript.segments),
				)
				.catch((error) => {
					console.error({
						tag: 'YOUTUBE',
						msg: 'Optional YouTube highlights failed after retries',
						processing_id: resource.processing_id,
						error: error instanceof Error ? error.message : String(error),
					});
					return null;
				})
		: null;
	return {
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
		version: '1.0',
		model: YOUTUBE_HIGHLIGHTS_MODEL,
		highlights: highlights.highlights,
		generatedAt,
	};
}
