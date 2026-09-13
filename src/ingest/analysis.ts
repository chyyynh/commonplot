import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { openai } from 'workers-ai-provider/openai';
import { z } from 'zod';
import type { AcquiredResource } from './acquisition';
import { coreGatewayOptions } from './ai-model';

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;
const ANALYSIS_MODEL = 'google/gemini-3.5-flash-lite';

const ResourceClassificationSchema = z.object({
	tags: z.array(z.string().trim().min(1)).min(1).max(5),
	keywords: z.array(z.string().trim().min(1)).min(1).max(8),
});

export type ResourceClassification = z.infer<typeof ResourceClassificationSchema>;

const RESOURCE_ANALYSIS_SYSTEM_PROMPT = `你是專業的新聞分類分析師。請只輸出符合 schema 的資料。

任務：
- 依重要性產生 1–5 個 tags、1–8 個 keywords，不湊數、不重複
- tags 表示主題與文章分類；keywords 提取具體的人物、組織、產品、技術與概念，使用原文語言

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement`;

function analysisModel(env: CoreEnv, processingId: string, feature: string) {
	const { gateway, extraHeaders } = coreGatewayOptions(env, { feature, processing_id: processingId });
	return createWorkersAI({ binding: env.AI, providers: [openai], gateway })(ANALYSIS_MODEL, { extraHeaders });
}

function analysisPrompt(resource: AcquiredResource) {
	return `文章資訊:
標題: ${resource.title}
來源: ${resource.source.trim()}
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

export async function classifyResource(resource: AcquiredResource, env: CoreEnv, processingId: string): Promise<ResourceClassification> {
	const startedAt = performance.now();
	const { finishReason, output, usage } = await generateText({
		model: analysisModel(env, processingId, 'resource-classification'),
		prompt: analysisPrompt(resource),
		system: RESOURCE_ANALYSIS_SYSTEM_PROMPT,
		output: Output.object({ name: 'resource_classification', schema: ResourceClassificationSchema }),
		maxOutputTokens: 300,
		temperature: 0.3,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource classification hit its output token cap');
	console.info({
		tag: 'AI',
		event: 'classification_completed',
		processing_id: processingId,
		model: ANALYSIS_MODEL,
		latency_ms: Math.round(performance.now() - startedAt),
		output_tokens: usage.outputTokens,
	});
	return output;
}
