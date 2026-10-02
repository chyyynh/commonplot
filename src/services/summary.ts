import { generateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { openai } from 'workers-ai-provider/openai';
import { z } from 'zod';
import type { AcquiredResource, EntitySource } from '../contracts/acquired-resource';
import { ENTITY_SALIENCES, ENTITY_TYPES, entityKey, type ResourceEntity } from '../contracts/resource';
import { coreGatewayOptions } from './ai-model';

const ANALYSIS_CONTENT_MAX_LENGTH = 10_000;
const ANALYSIS_MODEL = 'google/gemini-3.5-flash-lite';

function analysisModel(env: CoreEnv, processingId: string, feature: string) {
	const { gateway, extraHeaders } = coreGatewayOptions(env, { feature, processing_id: processingId });
	return createWorkersAI({ binding: env.AI, providers: [openai], gateway })(ANALYSIS_MODEL, { extraHeaders });
}

function analysisPrompt(resource: EntitySource) {
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

const MAX_ABOUT_ENTITIES = 4;
const MAX_MENTIONED_ENTITIES = 8;

const ENTITY_SYSTEM = `List the named entities this content is about, to relate it to other content about the same things.
Types: person; organization; product (software, AI model, hardware, service); work (paper, book, film, dataset, benchmark, law, standard); event (named incident, conference, deal, launch); place; concept (only a specific named technique or theory such as "RLHF" or "k-server problem", never a field or generic topic such as "AI", "materials science", "large language model" or "security").
Salience:
- about: the content is substantially about it; someone following this entity would want this content. At most ${MAX_ABOUT_ENTITIES}, most central first.
- mentions: named in passing, as an example, comparison or affiliation. At most ${MAX_MENTIONED_ENTITIES}, most specific first.
Leave out dates and numbers, the content's own publisher, site or author, and the platform it was posted on (Hacker News, X, Reddit, YouTube, GitHub) unless the content is about that itself.
Names:
- Write each as it is most commonly written in English, keeping the original only when it has no English form.
- Write the full specific name, completing a shortened one from the content: "Opus 5.5" is "Claude Opus 5.5", "Astra" is "GPT-6 Astra". Use a family name such as "Claude" or "Gemini" only when the content is about the whole family.
- When a name is short or shared by unrelated things, add what it is in parentheses: "Pi (coding agent)", "Mercury (planet)".`;

/** Every corpus original is related through what it is about; an extraction that names nothing is still an answer. */
export async function extractResourceEntities(resource: EntitySource, env: CoreEnv, processingId: string): Promise<ResourceEntity[]> {
	const { finishReason, output } = await generateText({
		model: analysisModel(env, processingId, 'resource-entities'),
		prompt: analysisPrompt(resource),
		system: ENTITY_SYSTEM,
		output: Output.object({
			name: 'resource_entities',
			schema: z.object({
				entities: z.array(z.object({ name: z.string().trim(), type: z.enum(ENTITY_TYPES), salience: z.enum(ENTITY_SALIENCES) })),
			}),
		}),
		maxOutputTokens: 1500,
		temperature: 0,
		maxRetries: 0,
	});
	if (finishReason === 'length') throw new Error('Resource entities hit their output token cap');
	const seen = new Set<string>();
	const distinct = output.entities.filter(({ name }) => {
		const key = entityKey(name);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return [
		...distinct.filter(({ salience }) => salience === 'about').slice(0, MAX_ABOUT_ENTITIES),
		...distinct.filter(({ salience }) => salience === 'mentions').slice(0, MAX_MENTIONED_ENTITIES),
	];
}
