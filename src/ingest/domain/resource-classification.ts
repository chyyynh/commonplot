import { RESOURCE_CATEGORIES, type ResourceCategory } from '@core-shared/resource-types';
import { ENTITY_TYPES, type ResolvedResource } from '@core-shared/types';
import { entityExtractionExclusionNames, type ResourceEntityInput } from '@entities/normalize';
import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

export interface ResourceClassificationResult {
	tags: string[];
	keywords: string[];
	entities: ResourceEntityInput[];
	category: ResourceCategory;
}

const CLASSIFICATION_CONTENT_MAX_LENGTH = 10000;

const ResourceClassificationSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	entities: z.array(
		z.object({
			name: z.string().min(1),
			name_cn: z.string().min(1),
			type: z.enum(ENTITY_TYPES),
		}),
	),
	category: z.enum(RESOURCE_CATEGORIES),
});

const RESOURCE_CLASSIFICATION_SYSTEM_PROMPT = `你是專業的新聞分類和實體分析師。請只輸出符合 schema 的分類資料。

任務：
- 產生 tags、keywords、category
- 擷取重要 named entities

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

實體擷取規則：
- 提取 3-8 個最重要的具名實體；如果文章太短，可以少於 3 個
- type 只能是 person, organization, product, technology, event, location
- name 用英文或原文慣用名稱；name_cn 用繁體中文，若無慣用中文名則與 name 相同
- 不要把文章來源、平台、作者名稱當作實體，除非文章主題就是該來源、平台或作者本身
- 不要提取泛詞、短縮碎片、股票代號或單字母縮寫，例如 AI、X、Go、US、C、RL、PI、$GOOGL
- 模型、產品、活動請使用完整慣用名稱，例如 Claude Opus 4.7、DeepSeek V4、TechCrunch Disrupt 2026
- 如果只能判斷出泛詞、版本碎片或來源名稱，寧可少提取

分類只能是：AI, Tech, Finance, Research, Business, Other。`;

function resourceClassificationPrompt(resource: ResolvedResource): string {
	const source = resource.source.trim();
	const content = resource.content.trim();
	const excludedEntities = entityExtractionExclusionNames(resource.resourcePlatform, resource.source, resource.creators);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';
	const summaryLine = resource.summary?.trim() ? `\n摘要: ${resource.summary.trim()}` : '';
	return `文章資訊:
標題: ${resource.title}
來源: ${source}
資源種類: ${resource.kind}
資源平台: ${resource.resourcePlatform ?? 'none'}${excludedLine}${summaryLine}
內容:
${content.substring(0, CLASSIFICATION_CONTENT_MAX_LENGTH)}`;
}

export async function classifyResource(
	resource: ResolvedResource,
	env: CoreEnv,
	processingId: string,
): Promise<ResourceClassificationResult> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: resource.title.substring(0, 80) });

	const { finishReason, output: classification } = await generateText({
		model: createWorkersAI({ binding: env.AI })('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
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
		prompt: resourceClassificationPrompt(resource),
		system: RESOURCE_CLASSIFICATION_SYSTEM_PROMPT,
		output: Output.object({ schema: ResourceClassificationSchema }),
		maxOutputTokens: 500,
		temperature: 0.3,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource classification hit its output token cap');
	const tags = classification.tags.slice(0, 5);
	const keywords = classification.keywords.slice(0, 8);
	return {
		category: classification.category,
		entities: classification.entities.slice(0, 10),
		tags: resource.tags.length ? resource.tags : [...new Set([...tags, classification.category])],
		keywords: resource.keywords.length ? resource.keywords : keywords,
	};
}
