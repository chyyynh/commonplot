import { RESOURCE_KINDS } from '../contracts/resource-kinds';
import { coreGatewayOptions } from '../services/ai-model';
import type { SearchDocument } from './search-index';

// Postgres is canonical; CORPUS_VECTORS is its derived index. Every searchable corpus Resource has one document
// vector `<id>:d` (title, source, summaries) and its original text as chunk vectors `<id>:<n>`; a private one has
// only its document vector, which every query but its owner's interests leaves out.
const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBEDDING_BATCH = 50;
/** bge-m3 reads 512 tokens; a document vector's text and a chunk's stored passage stay inside that. */
const VECTOR_TEXT_MAX_CHARS = 1_500;
const CHUNK_TOKENS = 400;
const CHUNK_OVERLAP_TOKENS = 40;
/** About 30,000 characters of English prose; longer or CJK text keeps only its opening chunks. */
const MAX_CHUNKS = 32;
const HARD_SPLIT_CHARS = 300;

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;

/** bge-m3 reads one token per CJK character and about 1.3 per other word. */
function estimateTokens(text: string): number {
	const cjk = text.match(CJK)?.length ?? 0;
	const words = text.replace(CJK, ' ').match(/\S+/g)?.length ?? 0;
	return cjk + Math.ceil(words * 1.3);
}

/** Paragraphs, split into sentences and then fixed slices only when one alone exceeds a chunk. */
function chunkUnits(text: string): string[] {
	const units: string[] = [];
	for (const paragraph of text.split(/\n{2,}/)) {
		const trimmed = paragraph.trim();
		if (!trimmed) continue;
		if (estimateTokens(trimmed) <= CHUNK_TOKENS) {
			units.push(trimmed);
			continue;
		}
		for (const sentence of trimmed.split(/(?<=[.!?。！？；])\s*/)) {
			if (!sentence) continue;
			if (estimateTokens(sentence) <= CHUNK_TOKENS) units.push(sentence);
			else
				for (let start = 0; start < sentence.length; start += HARD_SPLIT_CHARS) units.push(sentence.slice(start, start + HARD_SPLIT_CHARS));
		}
	}
	return units;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A slice can end inside a surrogate pair, and Workers AI rejects text with a lone surrogate. */
function clip(text: string, maxChars = VECTOR_TEXT_MAX_CHARS): string {
	return text.slice(0, maxChars).replace(LONE_SURROGATE, '\uFFFD');
}

/** Chunks of about CHUNK_TOKENS, each repeating the previous chunk's last units up to CHUNK_OVERLAP_TOKENS. */
function chunkText(text: string): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let size = 0;
	for (const unit of chunkUnits(text)) {
		const tokens = estimateTokens(unit);
		if (size + tokens > CHUNK_TOKENS && current.length) {
			chunks.push(current.join('\n\n'));
			const carry: string[] = [];
			let carried = 0;
			for (let index = current.length - 1; index >= 0 && carried < CHUNK_OVERLAP_TOKENS; index--) {
				carry.unshift(current[index]!);
				carried += estimateTokens(current[index]!);
			}
			current = carried > CHUNK_TOKENS / 2 ? [] : carry;
			size = carried > CHUNK_TOKENS / 2 ? 0 : carried;
		}
		current.push(unit);
		size += tokens;
	}
	if (current.length) chunks.push(current.join('\n\n'));
	return chunks.slice(0, MAX_CHUNKS);
}

/** A Resource's document vector; its chunks are `<id>:<n>`. */
export function documentVectorId(resourceId: string): string {
	return `${resourceId}:d`;
}

type CorpusVector = { id: string; text: string; metadata: Record<string, VectorizeVectorMetadataValue> };

function oneLine(text: string | null | undefined): string {
	return text?.replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * The document vector reads the title, source and every language's summary; an untitled kind's reads its text
 * instead of a title, which also covers it whole when short. Chunks open with the title as `head`.
 */
function documentText(document: SearchDocument) {
	const original = document.translations.find((translation) => translation.lang === document.original_lang);
	if (!original) throw new Error(`Search document ${document.id} is missing the ${document.original_lang} translation`);
	const titled = RESOURCE_KINDS[document.kind].titled;
	const content = original.content?.trim() ?? '';
	const title = oneLine(original.title);
	const head = titled ? `# ${title}` : oneLine(document.source);
	const summaries = document.translations.map((translation) =>
		[translation.title && oneLine(translation.title) !== title ? oneLine(translation.title) : '', oneLine(translation.summary)]
			.filter(Boolean)
			.join('\n'),
	);
	const text = clip([head, titled ? oneLine(document.source) : oneLine(content), ...summaries].filter(Boolean).join('\n\n'));
	if (!text) throw new Error(`Search document ${document.id} has no text`);
	return { text, head, titled, content };
}

/**
 * A corpus Resource's document vector and chunks, which open with the title so each knows its Resource. A private
 * Resource has only its document vector, as `role: 'private'` without its text: it shapes its owner's interests and
 * no search or recommendation reads it.
 */
function corpusVectors(document: SearchDocument): CorpusVector[] {
	const { text, head, titled, content } = documentText(document);
	if (document.scope === 'private')
		return [{ id: documentVectorId(document.id), text, metadata: { kind: document.kind, role: 'private', chunks: 0 } }];
	const metadata = {
		kind: document.kind,
		// Unix seconds: Vectorize filters ranges on numbers only.
		...(document.published_at === null ? {} : { published_at: Math.floor(new Date(document.published_at).getTime() / 1000) }),
		// Carriers such as HN threads and reposts name the Resource they discuss.
		...(document.subject_id ? { subject_id: document.subject_id } : {}),
		// Search ranks one-line posts below articles that match as well.
		chars: content.length,
	};
	// A short untitled text is already whole in its document vector.
	const chunks = !titled && content.length <= VECTOR_TEXT_MAX_CHARS ? [] : chunkText(content);
	return [
		// The document vector counts its chunks, so a later sync clears the ones a shorter text no longer has.
		{
			id: documentVectorId(document.id),
			text,
			metadata: { ...metadata, role: 'doc', chunks: chunks.length, text },
		},
		...chunks.map((chunk, index) => ({
			id: `${document.id}:${index}`,
			text: clip(`${head}\n\n${chunk}`),
			metadata: { ...metadata, role: 'chunk', text: clip(chunk) },
		})),
	];
}

/** The most vectors one upsert, ids one delete, and vectors one read takes. */
const UPSERT_BATCH = 500;
const DELETE_BATCH = 100;
const READ_BATCH = 20;

async function inBatches<T, R>(items: readonly T[], size: number, call: (batch: T[]) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let start = 0; start < items.length; start += size) results.push(await call(items.slice(start, start + size)));
	return results;
}

/** How many chunks each Resource's stored vectors have, by Resource id; a Resource without vectors is absent. */
async function storedChunkCounts(env: CoreEnv, resourceIds: readonly string[]): Promise<Map<string, number>> {
	const pages = await inBatches(resourceIds.map(documentVectorId), READ_BATCH, (ids) => env.CORPUS_VECTORS.getByIds(ids));
	return new Map(pages.flat().map((vector) => [vector.id.slice(0, -':d'.length), Number(vector.metadata?.chunks ?? 0)]));
}

async function embedTexts(env: CoreEnv, texts: readonly string[], feature: string): Promise<number[][]> {
	const vectors: number[][] = [];
	for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
		const batch = texts.slice(start, start + EMBEDDING_BATCH);
		const output = await env.AI.run(EMBEDDING_MODEL, { text: [...batch] }, coreGatewayOptions(env, { feature }));
		const data = 'data' in output ? output.data : undefined;
		if (!data || data.length !== batch.length)
			throw new Error(`${EMBEDDING_MODEL} returned ${data?.length ?? 0} of ${batch.length} vectors`);
		vectors.push(...data);
	}
	return vectors;
}

/** Upserts the current documents' vectors, drops chunks they no longer have, and deletes the rest. */
export async function syncCorpusVectors(env: CoreEnv, documents: readonly SearchDocument[], deletedIds: readonly string[]): Promise<void> {
	const stored = await storedChunkCounts(env, [...documents.map((document) => document.id), ...deletedIds]);
	const perDocument = documents.map(corpusVectors);
	const vectors = perDocument.flat();
	if (vectors.length) {
		const values = await embedTexts(
			env,
			vectors.map((vector) => vector.text),
			'corpus-vectors',
		);
		await inBatches(
			vectors.map((vector, index) => ({ id: vector.id, values: values[index]!, metadata: vector.metadata })),
			UPSERT_BATCH,
			(batch) => env.CORPUS_VECTORS.upsert(batch),
		);
	}
	const chunkIds = (id: string, from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, n) => `${id}:${from + n}`);
	const stale = [
		// Each document's vectors are its document vector, then its chunks.
		...documents.flatMap((document, index) => chunkIds(document.id, perDocument[index]!.length - 1, stored.get(document.id) ?? 0)),
		...deletedIds.flatMap((id) => (stored.has(id) ? [documentVectorId(id), ...chunkIds(id, 0, stored.get(id)!)] : [])),
	];
	await inBatches(stale, DELETE_BATCH, (batch) => env.CORPUS_VECTORS.deleteByIds(batch));
}

/** The stored document vectors of these Resources, by Resource id; one without a vector is absent. */
export async function readDocumentVectors(env: CoreEnv, resourceIds: readonly string[]): Promise<Map<string, number[]>> {
	const pages = await inBatches(resourceIds.map(documentVectorId), READ_BATCH, (ids) => env.CORPUS_VECTORS.getByIds(ids));
	return new Map(pages.flat().map((vector) => [vector.id.slice(0, -':d'.length), [...vector.values]]));
}

/** A matched passage of a Resource's indexed text, trimmed for a model to judge relevance. */
export type SearchPassage = { text: string; score: number };
export type CorpusHit = { id: string; subjectId: string | null; score: number; passages: SearchPassage[] };

/** Vectorize returns at most 50 matches with metadata; one long Resource can fill several. */
const QUERY_TOP_K = 50;
const PASSAGES_PER_RESULT = 3;
const PASSAGE_MAX_CHARS = 500;

/** A one-line post matches a name it repeats as well as an article about it does; the article ranks first. */
function lengthWeight(chars: number): number {
	if (chars < 200) return 0.85;
	if (chars < 600) return 0.93;
	return 1;
}

/** One hit per Resource at its best vector's weighted score, with its best-matching passages. */
export async function queryCorpusVectors(
	env: CoreEnv,
	query: string,
	filters: { kinds?: readonly string[]; publishedAfter?: Date },
): Promise<CorpusHit[]> {
	const [vector] = await embedTexts(env, [query], 'corpus-search');
	const filter: VectorizeVectorMetadataFilter = { role: { $ne: 'private' } };
	if (filters.kinds) filter.kind = { $in: [...filters.kinds] };
	if (filters.publishedAfter) filter.published_at = { $gte: Math.floor(filters.publishedAfter.getTime() / 1000) };
	const { matches } = await env.CORPUS_VECTORS.query(vector!, {
		topK: QUERY_TOP_K,
		returnMetadata: 'all',
		filter,
	});
	const hits = new Map<string, CorpusHit>();
	for (const match of matches) {
		const id = match.id.slice(0, match.id.indexOf(':'));
		const metadata = match.metadata ?? {};
		const score = match.score * lengthWeight(Number(metadata.chars ?? 0));
		const hit = hits.get(id) ?? {
			id,
			subjectId: typeof metadata.subject_id === 'string' ? metadata.subject_id : null,
			score,
			passages: [],
		};
		hit.score = Math.max(hit.score, score);
		hits.set(id, hit);
		// Matches come best first, so the first passages kept are the best.
		const text = typeof metadata.text === 'string' ? oneLine(metadata.text) : '';
		if (text && hit.passages.length < PASSAGES_PER_RESULT) hit.passages.push({ text: clip(text, PASSAGE_MAX_CHARS), score: match.score });
	}
	return [...hits.values()].sort((left, right) => right.score - left.score);
}
