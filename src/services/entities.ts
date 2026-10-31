import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pLimit from 'p-limit';
import { z } from 'zod';
import { cleanText } from '../contracts/markdown';
import { entityKey, type ResourceEntity } from '../contracts/resource';
import { type EntityKeyScheme, type EntityType } from '../contracts/resource-kinds';
import { withCoreDb } from '../store/db';
import { type DerivationSource, type EntityCandidate, listEntityCandidates, listHandleEntities } from '../store/derivations';
import {
	claimUnmatchedEntities,
	listJudgedEntities,
	listProductLines,
	mergeEntities,
	recordDistinct,
	releaseEntity,
	type UnmatchedEntity,
} from '../store/entities';
import { coreGatewayOptions, type GatewayMetadata } from './ai-model';

const FASTINO_URL = 'https://api.fastino.ai/v1/chat/completions';
const NER_MODEL = 'fastino/gliner2.5-multi-v1';
const JEV_MODEL = 'typesafe/jev';
const ENTITY_TEXT_MAX_LENGTH = 20_000;
/** GLiNER reads 4,096 tokens at most; sentences are packed up to this many characters. */
const NER_CHUNK_LENGTH = 1_500;
const NER_CONCURRENCY = 4;
const LEAD_LENGTH = 400;
const MAX_CANDIDATES = 10;
/** Questions per Jev call; one of them asks what the text is about. */
const MAX_LINK_QUESTIONS = 63;
const MAX_SUBJECT_OPTIONS = 10;
const MAX_ENTITIES = 16;
/** Below this weight, the site or an author of the text is only its byline, not something it is about. */
const CREDITED_MIN_WEIGHT = 0.1;
/** GLiNER is this sure a name is of its type before Jev is asked about a name no stored entity has. */
const NAMED_CONFIDENCE = 0.8;
/** A name becomes a new entity only when Jev is this sure it is a proper name; later texts link to it. */
const NEW_ENTITY_CONFIDENCE = 0.8;
/** Jev picks a stored candidate only with at least this probability. */
const CANDIDATE_CONFIDENCE = 0.5;

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

/** One name as the text writes it, keyed by its lowercase form. */
type Span = {
	text: string;
	type: NamedType;
	confidence: number;
	count: number;
	lead: boolean;
	candidates: EntityCandidate[];
	/** Written as an @handle somewhere in the text. */
	handle: boolean;
	entity?: { name: string; type: EntityType; key?: string };
	subject: number;
};

const cleanName = (text: string) => cleanText(text.replace(/’/gu, "'").replace(/'s$/u, '').replace(/^@/u, ''));
const spanKey = (text: string) => cleanName(text).toLowerCase();
/** Keys a name may be stored under: as written, without a version, singular or plural. */
function lookupKeys(name: string) {
	const names = [name, name.replace(/\s+v?\d+(?:\.\d+)*$/iu, '')];
	const keys = names.map(entityKey).filter(Boolean);
	return [...new Set(keys.flatMap((key) => [key, key.endsWith('s') ? key.slice(0, -1) : `${key}s`]))];
}

const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });

function textChunks(text: string) {
	const chunks: string[] = [];
	let current = '';
	for (const { segment } of sentences.segment(text)) {
		// Code or unpunctuated text forms one long sentence; cut it at the chunk length.
		for (let start = 0; start < segment.length; start += NER_CHUNK_LENGTH) {
			const piece = segment.slice(start, start + NER_CHUNK_LENGTH);
			if (current && current.length + piece.length > NER_CHUNK_LENGTH) {
				chunks.push(current);
				current = '';
			}
			current += piece;
		}
	}
	return [...chunks, current].filter((chunk) => chunk.trim());
}

const NerResponseSchema = z.object({
	choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
	usage: z.object({ total_tokens: z.number() }),
});
const NerEntitiesSchema = z.object({
	entities: z.partialRecord(z.enum(NAMED_TYPES.map(({ name }) => name)), z.array(z.object({ text: z.string(), confidence: z.number() }))),
});
type FoundNames = z.infer<typeof NerEntitiesSchema>['entities'];

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
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Fastino NER failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
	const body = NerResponseSchema.parse(await response.json());
	return { found: NerEntitiesSchema.parse(JSON.parse(body.choices[0].message.content)).entities, tokens: body.usage.total_tokens };
}

/** Each distinct name across the chunks, with a surname alone folded into the one full name it shortens. */
function collectSpans(chunks: readonly FoundNames[]) {
	const spans = new Map<string, Span>();
	for (const found of chunks)
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
					handle: false,
					subject: 0,
				};
				span.count++;
				span.handle ||= name.trim().startsWith('@');
				span.confidence = Math.max(span.confidence, confidence);
				spans.set(key, span);
			}
	const people = [...spans.values()].filter(({ type, text }) => type === 'person' && text.includes(' '));
	for (const [key, span] of spans) {
		if (span.type !== 'person' || span.text.includes(' ')) continue;
		const full = people.filter(({ text }) => [text.split(' ')[0], text.split(' ').at(-1)].some((part) => part?.toLowerCase() === key));
		if (full.length === 1) {
			full[0].count += span.count;
			spans.delete(key);
		}
	}
	return spans;
}

/** Each candidate once, at its best score: most alike first, then most used. */
function rankCandidates(found: Iterable<EntityCandidate>) {
	const best = new Map<string, EntityCandidate>();
	for (const candidate of found) if (candidate.score > (best.get(candidate.id)?.score ?? 0)) best.set(candidate.id, candidate);
	return [...best.values()].sort((a, b) => b.score - a.score || b.uses - a.uses);
}

/**
 * Stored entities each name may be, most alike first, and whether the text opens with it. An @handle of a known X
 * account is that account's entity, with nothing left to ask.
 */
async function attachCandidates(spans: Map<string, Span>, text: string, env: CoreEnv) {
	const lead = text.slice(0, LEAD_LENGTH).toLowerCase();
	const handles = [...spans].filter(([, span]) => span.handle).map(([key]) => key);
	const keys = [...new Set([...spans.keys()].flatMap(lookupKeys))];
	const names = [...new Set([...spans.values()].map(({ text }) => text.toLowerCase()))];
	const [stored, accounts] = await withCoreDb(env, (db) =>
		Promise.all([listEntityCandidates(db, keys, names), listHandleEntities(db, handles)]),
	);
	for (const account of accounts) {
		const span = spans.get(account.handle);
		if (span) span.entity = { name: account.name, type: account.type, key: account.key };
	}
	for (const [key, span] of spans) {
		const queries = new Set([...lookupKeys(key), span.text.toLowerCase()]);
		let found = rankCandidates(
			stored.filter((candidate) => queries.has(candidate.query) && LINKABLE_TYPES[span.type].includes(candidate.type)),
		);
		// Single-use variants are noise once a name has several candidates.
		if (found.some(({ uses }) => uses >= 2)) found = found.filter(({ uses }) => uses >= 2);
		span.lead = lead.includes(key);
		span.candidates = found.slice(0, MAX_CANDIDATES);
	}
}

const LinkAnswerSchema = z.union([
	z.object({ choice: z.string(), probabilities: z.record(z.string(), z.number()) }),
	z.object({ noul: z.number() }),
]);
const JevResultSchema = z.object({
	result: z.object({
		answers: z.record(z.string(), LinkAnswerSchema),
		usage: z.object({ input_tokens: z.number() }),
	}),
});
type JevQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> } | { type: 'noul'; instructions: string };

/** One Jev call through the ingest gateway: each question's answer, and the input tokens it read. */
export async function askJev(env: CoreEnv, metadata: GatewayMetadata, state: string, questions: Record<string, JevQuestion>) {
	const { gateway, signal } = coreGatewayOptions(env, metadata);
	const { result } = JevResultSchema.parse(
		await env.AI.run(JEV_MODEL as keyof AiModels, { state, questions } as never, { gateway, signal }),
	);
	return result;
}

/** A product that keeps releasing is one entity: its versions, tiers and sizes are not entities of their own. */
const PRODUCT_LINE_RULE =
	'A version, tier or size of a product is that product line (Claude Opus 4.5 is Claude, GPT-5.4 is GPT), but a different product with a similar name is not (Claude Code is not Claude, Apple TV+ is not Apple TV).';

/** One stored candidate as Jev reads it among the choices. */
const candidateCriterion = ({ name, type, example }: EntityCandidate) => `${name}, a ${type}${example ? `, as in "${example}"` : ''}`;

/** The question that settles a name: which stored candidate it is, or whether a new one is a proper name. */
function linkQuestion(span: Span): JevQuestion | null {
	if (span.candidates.length) {
		const criteria: Record<string, string> = Object.fromEntries(
			span.candidates.map((candidate, index) => [`c${index}`, candidateCriterion(candidate)]),
		);
		criteria.none = `None of these, or "${span.text}" is not a specific named thing here`;
		return { type: 'choice', instructions: `Which of these does "${span.text}" in the text refer to? ${PRODUCT_LINE_RULE}`, criteria };
	}
	if (span.confidence >= NAMED_CONFIDENCE && span.type !== 'place' && (span.lead || span.count >= 2))
		return {
			type: 'noul',
			instructions: `Is "${span.text}" the proper name of one specific ${span.type}, rather than a generic term, role, feature or description?`,
		};
	return null;
}

/**
 * One Jev call settles each name, leading and most repeated names first, and weighs which of them the
 * text is mainly about. Sets each settled span's entity and subject weight; returns the questions asked.
 */
async function settleSpans(spans: Iterable<Span>, text: string, env: CoreEnv, processingId: string) {
	const ranked = [...spans].sort((a, b) => Number(b.lead) - Number(a.lead) || b.count - a.count || b.confidence - a.confidence);
	const questions: Record<string, JevQuestion> = {};
	const asked: { id: string; span: Span }[] = [];
	for (const span of ranked) {
		if (asked.length >= MAX_LINK_QUESTIONS) break;
		if (span.entity) continue;
		const question = linkQuestion(span);
		if (!question) continue;
		const id = `q${asked.length}`;
		questions[id] = question;
		asked.push({ id, span });
	}
	const options = ranked
		.filter((span) => span.entity || span.candidates.length || span.confidence >= NAMED_CONFIDENCE)
		.slice(0, MAX_SUBJECT_OPTIONS);
	if (options.length)
		questions.subject = {
			type: 'choice',
			instructions: 'Which one of these is the text mainly about?',
			criteria: {
				...Object.fromEntries(options.map((span, index) => [`s${index}`, `"${span.text}"`])),
				none: 'None of these; the text is mainly about something else',
			},
		};
	if (!Object.keys(questions).length) return { questions: 0, tokens: 0 };

	const result = await askJev(env, { feature: 'resource-entities', processing_id: processingId }, text, questions);
	for (const { id, span } of asked) {
		const answer = result.answers[id];
		if (answer && 'choice' in answer && answer.choice !== 'none') {
			const picked = span.candidates[Number(answer.choice.slice(1))];
			if (picked && (answer.probabilities[answer.choice] ?? 0) >= CANDIDATE_CONFIDENCE)
				span.entity = { name: picked.name, type: picked.type, key: picked.key };
		} else if (answer && 'noul' in answer && answer.noul >= NEW_ENTITY_CONFIDENCE) span.entity = { name: span.text, type: span.type };
	}
	const subject = result.answers.subject;
	if (subject && 'probabilities' in subject) options.forEach((span, index) => (span.subject = subject.probabilities[`s${index}`] ?? 0));
	return { questions: Object.keys(questions).length, tokens: result.usage.input_tokens };
}

/**
 * Settled names that are one entity add up their subject weight; the most central entities are kept. The site and
 * the authors (`credited`) are kept only when the text is about them, as a company's blog is about its own models.
 */
function weighEntities(spans: Iterable<Span>, credited: readonly string[]): ResourceEntity[] {
	const entities = new Map<string, { name: string; type: EntityType; weight: number; key?: string; names: string[] }>();
	for (const span of spans) {
		if (!span.entity) continue;
		const key = span.entity.key ?? entityKey(span.entity.name);
		const entity = entities.get(key) ?? { ...span.entity, weight: 0, names: [] };
		entity.weight = Math.min(1, entity.weight + span.subject);
		entity.names.push(span.text);
		entities.set(key, entity);
	}
	const creditedKeys = new Set(credited.map(entityKey));
	return [...entities.values()]
		.filter((entity) => entity.weight >= CREDITED_MIN_WEIGHT || !creditedKeys.has(entityKey(entity.name)))
		.map((entity) => ({ ...entity, weight: Math.round(entity.weight * 1000) / 1000 }))
		.sort((a, b) => b.weight - a.weight)
		.slice(0, MAX_ENTITIES);
}

/**
 * Relates corpus originals through the named things they share. GLiNER finds the names, stored entities
 * written with the same or a similar name are the candidates, and one Jev call picks the candidate each name is,
 * tells a new name from a generic term, and weighs what the text is mainly about.
 */
export async function extractResourceEntities(
	resource: Pick<DerivationSource, 'title' | 'content' | 'source' | 'byline'>,
	env: CoreEnv,
	processingId: string,
): Promise<ResourceEntity[]> {
	const startedAt = performance.now();
	const text = `${resource.title ?? ''}\n${resource.content}`.trim().slice(0, ENTITY_TEXT_MAX_LENGTH);
	if (!text) return [];
	const limit = pLimit(NER_CONCURRENCY);
	const chunks = await Promise.all(textChunks(text).map((chunk) => limit(() => findNames(chunk, env))));
	const spans = collectSpans(chunks.map(({ found }) => found));
	await attachCandidates(spans, text, env);
	const link = await settleSpans(spans.values(), text, env, processingId);
	const entities = weighEntities(spans.values(), [resource.source, ...resource.byline]);
	console.info({
		tag: 'AI',
		event: 'entities_completed',
		processing_id: processingId,
		latency_ms: Math.round(performance.now() - startedAt),
		names: spans.size,
		questions: link.questions,
		ner_tokens: chunks.reduce((sum, { tokens }) => sum + tokens, 0),
		link_tokens: link.tokens,
		entities: entities.length,
	});
	return entities;
}

/** Entities matched in one sweep, and how many at once. */
const MATCH_BATCH = 300;
const MATCH_CONCURRENCY = 4;
/** How sure Jev must be before two entities merge, since a wrong merge moves Resources and followers. */
const MERGE_CONFIDENCE = 0.8;

type UnmatchedAccount = UnmatchedEntity & { scheme: EntityKeyScheme; value: string };

const ACCOUNT_KINDS: Record<EntityKeyScheme, string> = {
	twitter: 'An X account',
	youtube: 'A YouTube channel',
	hackernews: 'A Hacker News user',
	lesswrong: 'A LessWrong user',
	web: 'A website',
};

function describeAccount({ scheme, value, name, handle, titles }: UnmatchedAccount) {
	const lines = [`${ACCOUNT_KINDS[scheme]} named "${name}"${handle ? ` (@${handle})` : ''}${scheme === 'web' ? ` at ${value}` : ''}.`];
	if (titles.length) lines.push('Its latest posts:', ...titles.map((title) => `- ${title}`));
	return lines.join('\n');
}

function describeEntity({ name, type, names, titles }: UnmatchedEntity) {
	const others = names.filter((written) => written !== name.toLowerCase());
	const lines = [`"${name}", a ${type}${others.length ? `, also written ${others.map((written) => `"${written}"`).join(', ')}` : ''}.`];
	if (titles.length) lines.push('Resources mainly about it:', ...titles.map((title) => `- ${title}`));
	return lines.join('\n');
}

/** A candidate as Jev reads it, saying when it is itself an account rather than an entity Resources name. */
function accountCriterion(candidate: EntityCandidate) {
	const kind = ACCOUNT_KINDS[candidate.key.split(':')[0] as EntityKeyScheme];
	return kind ? `${candidateCriterion(candidate)} (${kind.toLowerCase()})` : candidateCriterion(candidate);
}

/** Stored entities with a name like the entity's that were never judged against it. */
async function listMatchCandidates(db: NodePgDatabase, entity: UnmatchedEntity, names: readonly string[], types?: readonly EntityType[]) {
	const [judged, found] = await Promise.all([
		listJudgedEntities(db, entity.id),
		listEntityCandidates(
			db,
			names.map(entityKey).filter(Boolean),
			names.map((name) => name.toLowerCase()),
		),
	]);
	// A candidate few Resources name, with nothing to read about it, can be told apart only by its name.
	return rankCandidates(found)
		.filter(
			({ id, type, uses, example }) => id !== entity.id && !judged.has(id) && (uses >= 2 || example) && (!types || types.includes(type)),
		)
		.slice(0, MAX_CANDIDATES);
}

/**
 * One account's entity against the stored entities with a name like the account's: Jev picks the one the account is,
 * which the account's entity merges into, or answers none, which is recorded so the pairs are never asked again.
 */
async function matchAccount(env: CoreEnv, db: NodePgDatabase, account: UnmatchedAccount) {
	const candidates = await listMatchCandidates(db, account, [account.name, account.handle ?? ''].filter(Boolean));
	if (!candidates.length) return 0;
	const criteria: Record<string, string> = Object.fromEntries(
		candidates.map((candidate, index) => [`c${index}`, accountCriterion(candidate)]),
	);
	criteria.none = 'None of these, or not sure';
	const { answers } = await askJev(env, { feature: 'entity-matching', processing_id: account.id }, describeAccount(account), {
		account: {
			type: 'choice',
			instructions:
				'Which of these is the same real-world person, organization or thing as this account? Something related but different, such as a product of a company or a company of its founder, is not the same. A similar name alone is not enough. If both an account and an entity fit, pick the entity.',
			criteria,
		},
	});
	const answer = answers.account;
	if (!answer || !('choice' in answer)) return 0;
	if (answer.choice === 'none') {
		await recordDistinct(
			db,
			account.id,
			candidates.map(({ id }) => id),
		);
		return 0;
	}
	const picked = candidates[Number(answer.choice.slice(1))];
	if (!picked || (answer.probabilities[answer.choice] ?? 0) < MERGE_CONFIDENCE) return 0;
	if (!(await mergeEntities(db, account.id, picked.id))) return 0;
	console.info({ tag: 'AI', event: 'entity_merged', account: `${account.scheme}:${account.value}`, name: account.name, into: picked.key });
	return 1;
}

/** Questions asking whether a product is a version of each product line its name starts with, and whether that line's name is a product's at all. */
function productLineQuestions(name: string, lines: readonly { name: string }[]): Record<string, JevQuestion> {
	return Object.fromEntries(
		lines.flatMap((line, index) => [
			[
				`line${index}`,
				{
					type: 'choice',
					instructions: `What is "${name}"?`,
					criteria: {
						version: `A model, version, tier, size or edition of ${line.name} itself`,
						separate: `A separate app, tool, feature, service, platform or program that carries the ${line.name} name`,
						unrelated: 'Something unrelated that only shares the name',
					},
				},
			],
			[
				`named${index}`,
				{
					type: 'noul',
					instructions: `Is "${line.name}" on its own the name of one specific product or product line, rather than a generic word, tier or version number?`,
				},
			],
		]),
	);
}

/**
 * An entity Resources name against the stored entities named alike, one question each, since several may be it. Those
 * Jev is sure are the same merge into the most named of them, and the rest are recorded as different. A product that
 * is a version of a product line its name starts with (Claude Opus 4.5 of Claude) merges, with them, into that line.
 */
async function matchNamedEntity(env: CoreEnv, db: NodePgDatabase, entity: UnmatchedEntity) {
	const types = entity.type in LINKABLE_TYPES ? LINKABLE_TYPES[entity.type as NamedType] : [entity.type];
	const [candidates, lines] = await Promise.all([
		listMatchCandidates(db, entity, [entity.name, ...entity.names], types),
		entity.type === 'product' ? listProductLines(db, entity.id, entity.name) : [],
	]);
	if (!candidates.length && !lines.length) return 0;
	const questions: Record<string, JevQuestion> = {
		...Object.fromEntries(
			candidates.map((candidate, index) => [
				`c${index}`,
				{
					type: 'noul',
					instructions: `Is "${entity.name}" described here the same thing as ${accountCriterion(candidate)}? ${PRODUCT_LINE_RULE} A company and its product, or a person and their company, are not the same. A similar name alone is not enough.`,
				},
			]),
		),
		...productLineQuestions(entity.name, lines),
	};
	const { answers } = await askJev(env, { feature: 'entity-matching', processing_id: entity.id }, describeEntity(entity), questions);
	const sure = (id: string) => {
		const answer = answers[id];
		return answer && 'noul' in answer ? answer.noul : 0;
	};
	const line = lines.find((_, index) => {
		const answer = answers[`line${index}`];
		const version = answer && 'probabilities' in answer ? (answer.probabilities.version ?? 0) : 0;
		return version >= MERGE_CONFIDENCE && sure(`named${index}`) >= MERGE_CONFIDENCE;
	});
	const same = candidates.filter((_, index) => sure(`c${index}`) >= MERGE_CONFIDENCE);
	console.info({
		tag: 'AI',
		event: 'entity_judged',
		name: entity.name,
		uses: entity.uses,
		line: line?.key,
		same: same.map(({ key }) => key),
		different: candidates.filter((candidate) => !same.includes(candidate)).map(({ key }) => key),
	});
	await recordDistinct(
		db,
		entity.id,
		candidates.filter((candidate) => !same.includes(candidate) && candidate.id !== line?.id).map(({ id }) => id),
	);
	const group = [{ id: entity.id, key: entity.name, uses: entity.uses }, ...same].sort((a, b) => b.uses - a.uses);
	const winner = line ?? group[0];
	let merged = 0;
	for (const loser of group)
		if (loser.id !== winner.id && (await mergeEntities(db, loser.id, winner.id))) {
			console.info({ tag: 'AI', event: 'entity_merged', name: loser.key, into: winner.key });
			merged++;
		}
	return merged;
}

/** Matches unmatched entities against the others, a batch a sweep, most named first; a failed one waits for the next. */
export async function matchEntities(env: CoreEnv, db: NodePgDatabase) {
	const entities = await claimUnmatchedEntities(db, MATCH_BATCH);
	const limit = pLimit(MATCH_CONCURRENCY);
	const merged = await Promise.all(
		entities.map((entity) =>
			limit(async () => {
				try {
					return await (entity.scheme ? matchAccount(env, db, entity as UnmatchedAccount) : matchNamedEntity(env, db, entity));
				} catch (error) {
					await releaseEntity(db, entity.id);
					console.warn({ tag: 'AI', event: 'entity_match_failed', entity_id: entity.id, error: String(error) });
					return 0;
				}
			}),
		),
	);
	if (entities.length)
		console.info({ tag: 'AI', event: 'entities_matched', entities: entities.length, merged: merged.reduce((sum, n) => sum + n, 0) });
}
