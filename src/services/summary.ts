import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { openai } from 'workers-ai-provider/openai';
import { z } from 'zod';
import type { AcquiredResource } from '../contracts/acquired-resource';
import { coreGatewayOptions } from './ai-model';

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;
const ANALYSIS_MODEL = 'google/gemini-3.5-flash-lite';

function analysisModel(env: CoreEnv, processingId: string, feature: string) {
	const { gateway, extraHeaders } = coreGatewayOptions(env, { feature, processing_id: processingId });
	return createWorkersAI({ binding: env.AI, providers: [openai], gateway })(ANALYSIS_MODEL, { extraHeaders });
}

function analysisPrompt(resource: AcquiredResource) {
	return `文章資訊:
${resource.title ? `標題: ${resource.title}\n` : ''}來源: ${resource.source.trim()}
資源種類: ${resource.kind}
資源平台: ${resource.resourcePlatform ?? 'none'}
原文語言: ${resource.originalLang}
來源摘要: ${resource.summary ?? '未提供'}
內容:
${resource.content.trim().substring(0, ANALYSIS_CONTENT_MAX_LENGTH)}`;
}

/** Called only when acquisition supplied no summary. */
export async function summarizeResource(resource: AcquiredResource, env: CoreEnv, processingId: string) {
	const startedAt = performance.now();
	const { finishReason, output, usage } = await generateText({
		model: analysisModel(env, processingId, 'resource-summary'),
		prompt: analysisPrompt(resource),
		system: `以指定原文語言撰寫 1–2 句摘要；原文語言為 und 時使用內容的主要語言。
只產生一種語言，保留歸屬、語氣、限制與不確定性，不加入正文沒有的資訊。
討論串摘要描述討論內容；短貼文摘要長度應與原文相稱。`,
		output: Output.object({ name: 'resource_summary', schema: z.object({ summary: z.string().trim().min(1) }) }),
		maxOutputTokens: 1000,
		temperature: 0.3,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource summary hit its output token cap');
	console.info({
		tag: 'AI',
		event: 'summary_completed',
		processing_id: processingId,
		model: ANALYSIS_MODEL,
		latency_ms: Math.round(performance.now() - startedAt),
		output_tokens: usage.outputTokens,
	});
	return output.summary;
}
