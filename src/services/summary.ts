import { generateText, Output } from 'ai';
import pLimit from 'p-limit';
import { createWorkersAI } from 'workers-ai-provider';
import { openai } from 'workers-ai-provider/openai';
import { z } from 'zod';
import type { AcquiredResource, EntitySource } from '../contracts/acquired-resource';
import { type EntityType, entityKey, type ResourceEntity } from '../contracts/resource';
import { withCoreDb } from '../store/db';
import { type EntityCandidate, listEntityCandidates } from '../store/resources';
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

const FASTINO_URL = 'https://api.fastino.ai/v1/chat/completions';
const NER_MODEL = 'fastino/gliner2.5-multi-v1';
const LINK_MODEL = 'typesafe/jev';
const ENTITY_TEXT_MAX_LENGTH = 20_000;
/** GLiNER reads 4,096 tokens at most; sentences are packed up to this many characters. */
const NER_CHUNK_LENGTH = 1_500;
const NER_CONCURRENCY = 4;
const LEAD_LENGTH = 400;
const MAX_CANDIDATES = 6;
/** Questions per Jev call; one of them asks what the text is about. */
const MAX_LINK_QUESTIONS = 63;
const MAX_SUBJECT_OPTIONS = 10;
const MAX_ENTITIES = 16;
const NAMED_CONFIDENCE = 0.8;
/** A name becomes a new entity only when Jev is this sure it is a proper name; later texts link to it. */
const NEW_ENTITY_CONFIDENCE = 0.8;

type NamedType = Exclude<EntityType, 'concept'>;

const NAMED_TYPES: readonly { name: NamedType; description: string }[] = [
	{ name: 'person', description: 'a named individual person' },
	{ name: 'organization', description: 'a named company, institution, government body or group' },
	{ name: 'product', description: 'a named software, app, AI model, device or service' },
	{ name: 'work', description: 'a named article, paper, book, film, show or report' },
	{ name: 'event', description: 'a named conference, launch event or incident' },
	{ name: 'place', description: 'a named country, city or location' },
];

/** Stored types a name found as each type may be; GLiNER often calls a product its company and back. */
const LINKABLE_TYPES: Record<NamedType, readonly EntityType[]> = {
	person: ['person', 'concept'],
	organization: ['organization', 'product', 'concept'],
	product: ['product', 'organization', 'work', 'concept'],
	work: ['work', 'product', 'concept'],
	event: ['event', 'concept'],
	place: ['place', 'organization', 'concept'],
};

type Span = {
	text: string;
	type: NamedType;
	confidence: number;
	count: number;
	lead: boolean;
	candidates: EntityCandidate[];
	entity?: { name: string; type: EntityType };
	subject: number;
};

const cleanName = (text: string) => text.replace(/’/gu, "'").replace(/'s$/u, '').replace(/^@/u, '').replace(/\s+/gu, ' ').trim();
const spanKey = (text: string) => cleanName(text).toLowerCase();
/** Keys a name may be stored under: as written, without a version, singular or plural. */
function lookupKeys(name: string) {
	const names = [name, name.replace(/\s+v?\d+(?:\.\d+)*$/iu, '')];
	const keys = names.map(entityKey).filter(Boolean);
	return [...new Set(keys.flatMap((key) => [key, key.endsWith('s') ? key.slice(0, -1) : `${key}s`]))];
}

function textChunks(text: string) {
	const chunks: string[] = [];
	let current = '';
	for (const sentence of text.split(/(?<=[.!?。！？\n])\s+/u)) {
		if (current && current.length + sentence.length > NER_CHUNK_LENGTH) {
			chunks.push(current);
			current = '';
		}
		current += `${sentence} `;
	}
	return current.trim() ? [...chunks, current] : chunks;
}

const NerResponseSchema = z.object({
	choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
	usage: z.object({ total_tokens: z.number() }),
});
const NerEntitiesSchema = z.object({
	entities: z.partialRecord(z.enum(NAMED_TYPES.map(({ name }) => name)), z.array(z.object({ text: z.string(), confidence: z.number() }))),
});

/** Names GLiNER finds in one chunk, with their types. */
async function findNames(chunk: string, env: CoreEnv) {
	const response = await fetch(FASTINO_URL, {
		method: 'POST',
		headers: { authorization: `Bearer ${env.FASTINO_API_KEY}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model: NER_MODEL,
			store: false,
			messages: [{ role: 'user', content: chunk }],
			schema: { entities: NAMED_TYPES },
		}),
	});
	if (!response.ok) throw new Error(`Fastino NER failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
	const body = NerResponseSchema.parse(await response.json());
	return { found: NerEntitiesSchema.parse(JSON.parse(body.choices[0].message.content)).entities, tokens: body.usage.total_tokens };
}

const LinkAnswerSchema = z.union([
	z.object({ choice: z.string(), probabilities: z.record(z.string(), z.number()) }),
	z.object({ noul: z.number() }),
]);
const LinkResultSchema = z.object({
	result: z.object({
		answers: z.record(z.string(), LinkAnswerSchema),
		usage: z.object({ input_tokens: z.number() }),
	}),
});
type LinkQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> } | { type: 'noul'; instructions: string };

const describeCandidate = (candidate: EntityCandidate) =>
	`${candidate.name}, a ${candidate.type}${candidate.example ? `, as in "${candidate.example}"` : ''}`;

/**
 * Relates corpus originals through the named things they share. GLiNER finds the names, stored entities
 * of the same name are the candidates, and one Jev call picks the candidate each ambiguous name is,
 * tells a new name from a generic term, and weighs what the text is mainly about.
 */
export async function extractResourceEntities(resource: EntitySource, env: CoreEnv, processingId: string): Promise<ResourceEntity[]> {
	const startedAt = performance.now();
	const text = `${resource.title ?? ''}\n${resource.content}`.trim().slice(0, ENTITY_TEXT_MAX_LENGTH);
	if (!text) return [];
	const limit = pLimit(NER_CONCURRENCY);
	const chunks = await Promise.all(textChunks(text).map((chunk) => limit(() => findNames(chunk, env))));

	const spans = new Map<string, Span>();
	for (const { found } of chunks)
		for (const { name: type } of NAMED_TYPES)
			for (const { text: name, confidence } of found[type] ?? []) {
				const key = spanKey(name);
				if (!key) continue;
				const span = spans.get(key) ?? {
					text: cleanName(name),
					type,
					confidence: 0,
					count: 0,
					lead: false,
					candidates: [],
					subject: 0,
				};
				span.count++;
				span.confidence = Math.max(span.confidence, confidence);
				spans.set(key, span);
			}
	// A surname alone is the full name it shortens in the same text.
	const people = [...spans.values()].filter(({ type, text }) => type === 'person' && text.includes(' '));
	for (const [key, span] of spans) {
		if (span.type !== 'person' || span.text.includes(' ')) continue;
		const full = people.filter(({ text }) => [text.split(' ')[0], text.split(' ').at(-1)].some((part) => part?.toLowerCase() === key));
		if (full.length === 1) {
			full[0].count += span.count;
			spans.delete(key);
		}
	}

	const lead = text.slice(0, LEAD_LENGTH).toLowerCase();
	const stored = await withCoreDb(env, (db) => listEntityCandidates(db, [...new Set([...spans.keys()].flatMap(lookupKeys))]));
	for (const [key, span] of spans) {
		const keys = new Set(lookupKeys(key));
		let found = stored.filter((candidate) => keys.has(candidate.bare) && LINKABLE_TYPES[span.type].includes(candidate.type));
		// Single-use variants are noise once a name has several candidates.
		if (found.filter(({ uses }) => uses >= 2).length) found = found.filter(({ uses }) => uses >= 2);
		span.lead = lead.includes(key);
		span.candidates = found.sort((a, b) => b.uses - a.uses).slice(0, MAX_CANDIDATES);
	}

	const ranked = [...spans.values()].sort((a, b) => Number(b.lead) - Number(a.lead) || b.count - a.count || b.confidence - a.confidence);
	const questions: Record<string, LinkQuestion> = {};
	const asked: { id: string; span: Span }[] = [];
	for (const span of ranked) {
		if (asked.length >= MAX_LINK_QUESTIONS) break;
		const id = `q${asked.length}`;
		if (span.candidates.length) {
			const criteria: Record<string, string> = Object.fromEntries(
				span.candidates.map((candidate, index) => [`c${index}`, describeCandidate(candidate)]),
			);
			criteria.none = `None of these, or "${span.text}" is not a specific named thing here`;
			questions[id] = { type: 'choice', instructions: `Which of these does "${span.text}" in the text refer to?`, criteria };
		} else if (!span.candidates.length && span.confidence >= NAMED_CONFIDENCE && span.type !== 'place' && (span.lead || span.count >= 2)) {
			questions[id] = {
				type: 'noul',
				instructions: `Is "${span.text}" the proper name of one specific ${span.type}, rather than a generic term, role, feature or description?`,
			};
		} else continue;
		asked.push({ id, span });
	}
	const options = ranked.filter((span) => span.candidates.length || span.confidence >= NAMED_CONFIDENCE).slice(0, MAX_SUBJECT_OPTIONS);
	if (options.length)
		questions.subject = {
			type: 'choice',
			instructions: 'Which one of these is the text mainly about?',
			criteria: {
				...Object.fromEntries(options.map((span, index) => [`s${index}`, `"${span.text}"`])),
				none: 'None of these; the text is mainly about something else',
			},
		};

	let tokens = 0;
	if (Object.keys(questions).length) {
		const { gateway } = coreGatewayOptions(env, { feature: 'resource-entities', processing_id: processingId });
		const { result } = LinkResultSchema.parse(
			await env.AI.run(LINK_MODEL as keyof AiModels, { state: text, questions } as never, { gateway }),
		);
		tokens = result.usage.input_tokens;
		for (const { id, span } of asked) {
			const answer = result.answers[id];
			if (answer && 'choice' in answer && answer.choice !== 'none') {
				const picked = span.candidates[Number(answer.choice.slice(1))];
				if (picked && (answer.probabilities[answer.choice] ?? 0) >= 0.5) span.entity = { name: picked.name, type: picked.type };
			} else if (answer && 'noul' in answer && answer.noul >= NEW_ENTITY_CONFIDENCE) span.entity = { name: span.text, type: span.type };
		}
		const subject = result.answers.subject;
		if (subject && 'probabilities' in subject) options.forEach((span, index) => (span.subject = subject.probabilities[`s${index}`] ?? 0));
	}

	const entities = new Map<string, { name: string; type: EntityType; weight: number }>();
	for (const span of spans.values()) {
		if (!span.entity) continue;
		const key = entityKey(span.entity.name);
		const entity = entities.get(key) ?? { ...span.entity, weight: 0 };
		entity.weight = Math.min(1, entity.weight + span.subject);
		entities.set(key, entity);
	}
	const result = [...entities.values()]
		.map((entity) => ({ ...entity, weight: Math.round(entity.weight * 1000) / 1000 }))
		.sort((a, b) => b.weight - a.weight)
		.slice(0, MAX_ENTITIES);
	console.info({
		tag: 'AI',
		event: 'entities_completed',
		processing_id: processingId,
		latency_ms: Math.round(performance.now() - startedAt),
		names: spans.size,
		questions: Object.keys(questions).length,
		ner_tokens: chunks.reduce((sum, { tokens: used }) => sum + used, 0),
		link_tokens: tokens,
		entities: result.length,
	});
	return result;
}
