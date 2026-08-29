import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { canonicalizeResourceLang, type RESOURCE_TYPES, type ResourceCreator } from '../shared/resource';
import type { ProcessingResource } from './acquisition';
import { CORE_STRUCTURED_MODEL_SETTINGS, CORE_TEXT_MODEL } from './ai-model';

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;
const ENTITY_NAME_MAX_LENGTH = 255;
const MAX_EXCLUSION_NAMES = 10;
const ASCII_TICKER_ENTITY_RE = /^\$[a-z]{1,5}$/i;
const SOURCE_SUFFIX_CANONICALS = new Set([
	'ai',
	'article',
	'articles',
	'blog',
	'business',
	'crypto',
	'finance',
	'news',
	'research',
	'rss',
	'startup',
	'startups',
	'tech',
	'technology',
]);

const ResourceEntitiesSchema = z
	.array(
		z.object({
			name: z.string().trim().min(1),
			name_cn: z.string().trim(),
			type: z.enum(['person', 'organization', 'product', 'technology', 'event', 'location']),
		}),
	)
	.max(10);

const ResourceAnalysisSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	entities: ResourceEntitiesSchema,
	originalLang: z
		.string()
		.trim()
		.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
});

export type ResourceAnalysis = z.infer<typeof ResourceAnalysisSchema>;

type StoredResourceEntity = { k: string; n: string; cn: string | null; t: z.infer<typeof ResourceEntitiesSchema>[number]['type'] };

const RESOURCE_ANALYSIS_SYSTEM_PROMPT = `你是專業的新聞分類和實體分析師。請只輸出符合 schema 的分類資料。

任務：
- 產生 tags、keywords
- 擷取重要 named entities
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
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

實體擷取規則：
- 提取 3-8 個最重要的具名實體；如果文章太短，可以少於 3 個
- type 只能是 person, organization, product, technology, event, location
- name 用英文或原文慣用名稱；name_cn 用繁體中文，若無慣用中文名則與 name 相同
- 不要把文章來源、平台、作者名稱當作實體，除非文章主題就是該來源、平台或作者本身
- 不要提取泛詞、短縮碎片、股票代號或單字母縮寫，例如 AI、X、Go、US、C、RL、PI、$GOOGL
- 模型、產品、活動請使用完整慣用名稱，例如 Claude Opus 4.7、DeepSeek V4、TechCrunch Disrupt 2026
- 如果只能判斷出泛詞、版本碎片或來源名稱，寧可少提取`;

// Keep punctuation that can be part of a real name; strip only surrounding quotes/brackets.
function canonicalEntityName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKC')
		.replace(/\s+/g, ' ')
		.replace(/^[\s"'`“”‘’([{]+|[\s"'`“”‘’]+$/g, '')
		.trim();
}

function sourceAliases(source?: string | null): string[] {
	const value = source?.trim();
	if (!value) return [];
	const aliases = [value];
	const suffixMatch = value.match(/^(.+?)\s+[-–—|:]\s+(.+)$/);
	if (suffixMatch) {
		const [, base, suffix] = suffixMatch;
		const suffixTokens = canonicalEntityName(suffix)
			.split(/[\s/]+/)
			.filter(Boolean);
		if (suffixTokens.length && suffixTokens.every((token) => SOURCE_SUFFIX_CANONICALS.has(token))) aliases.push(base.trim());
	}

	const parsed = URL.parse(value.includes('://') ? value : `https://${value}`);
	const host = parsed?.hostname.replace(/^www\./, '');
	if (host) {
		aliases.push(host);
		const firstLabel = host.split('.')[0];
		if (host.includes('.') && firstLabel) aliases.push(firstLabel);
	}
	return aliases;
}

function creatorAliases(creators: readonly ResourceCreator[]): string[] {
	return creators.flatMap((creator) => {
		const name = creator.literal ?? ([creator.given, creator.family].filter(Boolean).join(' ') || null);
		if (!name) return [];
		const handle = creator.handle?.replace(/^@/, '').trim();
		return handle ? [name, handle, `@${handle}`] : [name];
	});
}

function entityExtractionExclusionNames(
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null,
	source?: string | null,
	creators: readonly ResourceCreator[] = [],
): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const name of [...sourceAliases(source), ...creatorAliases(creators), ...(resourcePlatform === null ? [] : [resourcePlatform])]) {
		const canonical = canonicalEntityName(name);
		if (!canonical || seen.has(canonical)) continue;
		seen.add(canonical);
		names.push(name.trim());
		if (names.length >= MAX_EXCLUSION_NAMES) break;
	}
	return names;
}

export async function analyzeResource(
	resource: ProcessingResource,
	keywordHints: readonly string[],
	env: CoreEnv,
	processingId: string,
): Promise<ResourceAnalysis> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: resource.title.substring(0, 80) });
	const excludedEntities = entityExtractionExclusionNames(resource.resourcePlatform, resource.source, resource.creators);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';
	const summaryLine = resource.summary?.trim() ? `\n摘要: ${resource.summary.trim()}` : '';
	const prompt = `文章資訊:
標題: ${resource.title}
來源: ${resource.source.trim()}
資源種類: ${resource.kind}
資源平台: ${resource.resourcePlatform ?? 'none'}${excludedLine}${summaryLine}
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
		maxOutputTokens: 500,
		temperature: 0.3,
		reasoning: 'none',
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource analysis hit its output token cap');
	return {
		entities: analysis.entities,
		tags: analysis.tags.slice(0, 5),
		keywords: keywordHints.length ? [...keywordHints] : analysis.keywords.slice(0, 8),
		originalLang: canonicalizeResourceLang(analysis.originalLang),
	};
}

export function toStoredResourceEntities(
	entities: ResourceAnalysis['entities'],
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null,
	source?: string | null,
	creators: readonly ResourceCreator[] = [],
): StoredResourceEntity[] {
	const excluded = new Set(entityExtractionExclusionNames(resourcePlatform, source, creators).map(canonicalEntityName));
	const stored = new Map<string, StoredResourceEntity>();
	for (const entity of entities) {
		const canonical = canonicalEntityName(entity.name);
		if (
			!canonical ||
			stored.has(canonical) ||
			/^[a-z0-9]{1,2}$/i.test(canonical) ||
			canonical.length > ENTITY_NAME_MAX_LENGTH ||
			entity.name.length > ENTITY_NAME_MAX_LENGTH ||
			entity.name_cn.length > ENTITY_NAME_MAX_LENGTH ||
			ASCII_TICKER_ENTITY_RE.test(canonical) ||
			excluded.has(canonical)
		) {
			continue;
		}
		stored.set(canonical, {
			k: canonical,
			n: entity.name,
			cn: entity.name_cn || null,
			t: entity.type,
		});
	}
	return [...stored.values()].sort((a, b) => a.k.localeCompare(b.k));
}
