import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { canonicalizeResourceLang } from '../shared/resource';
import type { ProcessingResource } from './acquisition';
import { CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;

const ResourceAnalysisSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	originalLang: z
		.string()
		.trim()
		.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
});

export type ResourceAnalysis = z.infer<typeof ResourceAnalysisSchema>;

const RESOURCE_ANALYSIS_SYSTEM_PROMPT = `你是專業的新聞分類分析師。請只輸出符合 schema 的分類資料。

任務：
- 產生 tags、keywords
- 判斷標題與內容的主要原文語言，使用 BCP-47 language tag

語言規則：
- 依內容判斷，不要依來源、平台或作者推測
- 繁體中文使用 zh-Hant，簡體中文使用 zh-Hans
- 英文使用 en，日文使用 ja；其他語言使用對應的 canonical language tag
- 多語內容選擇佔比最高的主要語言

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement`;

export async function analyzeResource(
	resource: ProcessingResource,
	keywordHints: readonly string[],
	env: CoreEnv,
	processingId: string,
): Promise<ResourceAnalysis> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: resource.title.substring(0, 80) });
	const summaryLine = resource.summary?.trim() ? `\n摘要: ${resource.summary.trim()}` : '';
	const prompt = `文章資訊:
標題: ${resource.title}
來源: ${resource.source.trim()}
資源種類: ${resource.kind}
資源平台: ${resource.resourcePlatform ?? 'none'}${summaryLine}
內容:
${resource.content.trim().substring(0, ANALYSIS_CONTENT_MAX_LENGTH)}`;
	const { finishReason, output: analysis } = await generateText({
		model: createWorkersAI({ binding: env.AI })(CORE_TEXT_MODEL, {
			...CORE_STRUCTURED_MODEL_SETTINGS,
			gateway: {
				id: 'core-ingest',
				collectLog: true,
				retries: { maxAttempts: 1 },
				metadata: {
					feature: 'resource-classification',
					environment: env.AI_GATEWAY_ENVIRONMENT,
					processing_id: processingId,
				},
			},
			extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
		}),
		prompt,
		system: RESOURCE_ANALYSIS_SYSTEM_PROMPT,
		output: Output.object({ name: 'resource_analysis', schema: ResourceAnalysisSchema }),
		maxOutputTokens: 300,
		temperature: 0.3,
		reasoning: 'none',
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource analysis hit its output token cap');
	return {
		tags: analysis.tags.slice(0, 5),
		keywords: keywordHints.length ? [...keywordHints] : analysis.keywords.slice(0, 8),
		originalLang: canonicalizeResourceLang(analysis.originalLang),
	};
}
