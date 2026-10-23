import { RESOURCE_KINDS } from '../contracts/resource-kinds';
import { coreGatewayOptions } from '../services/ai-model';
import type { CorpusDocument } from './search-index';

// Postgres is canonical; CORPUS_VECTORS is its derived public-corpus index. Every searchable Resource has one
// document vector `<id>:d` (title, source, summaries) and its original text as chunk vectors `<id>:<n>`.
const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBEDDING_BATCH = 50;
/** bge-m3 reads 512 tokens; a document vector's text and a chunk's stored passage stay inside that. */
const VECTOR_TEXT_MAX_CHARS = 1_500;
const CHUNK_TOKENS = 400;
const CHUNK_OVERLAP_TOKENS = 40;
/** Original content arrives capped at 8,000 characters, which never splits past this many chunks. */
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

/** Chunks of about CHUNK_TOKENS, each repeating the previous chunk's last units up to CHUNK_OVERLAP_TOKENS. */
export function chunkText(text: string): string[] {
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

type CorpusVector = { id: string; text: string; metadata: Record<string, VectorizeVectorMetadataValue> };

function oneLine(text: string | null | undefined): string {
	return text?.replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * The document vector reads the title, source and every language's summary; an untitled kind's reads its text
 * instead of a title, which also covers it whole when short. Chunks open with the title so each knows its Resource.
 */
function corpusVectors(document: CorpusDocument): CorpusVector[] {
	const original = document.translations.find((translation) => translation.lang === document.original_lang);
	if (!original) throw new Error(`Corpus vectors ${document.id} are missing the ${document.original_lang} translation`);
	const titled = RESOURCE_KINDS[document.kind].titled;
	const content = original.content?.trim() ?? '';
	const title = oneLine(original.title);
	const head = titled ? `# ${title}` : oneLine(document.source);
	const summaries = document.translations.map((translation) =>
		[translation.title && oneLine(translation.title) !== title ? oneLine(translation.title) : '', oneLine(translation.summary)]
			.filter(Boolean)
			.join('\n'),
	);
	const documentText = [head, titled ? oneLine(document.source) : oneLine(content), ...summaries]
		.filter(Boolean)
		.join('\n\n')
		.slice(0, VECTOR_TEXT_MAX_CHARS);
	if (!documentText) throw new Error(`Corpus vectors ${document.id} have no text`);
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
		{ id: `${document.id}:d`, text: documentText, metadata: { ...metadata, role: 'doc', text: documentText } },
		...chunks.map((chunk, index) => ({
			id: `${document.id}:${index}`,
			text: `${head}\n\n${chunk}`.slice(0, VECTOR_TEXT_MAX_CHARS),
			metadata: { ...metadata, role: 'chunk', text: chunk.slice(0, VECTOR_TEXT_MAX_CHARS) },
		})),
	];
}

/** Chunk ids from `fromChunk` on, which a Resource whose text got shorter may still hold. */
function chunkIdsFrom(resourceId: string, fromChunk: number): string[] {
	return Array.from({ length: MAX_CHUNKS - fromChunk }, (_, offset) => `${resourceId}:${fromChunk + offset}`);
}

/** Vectorize takes a bounded number of vectors or ids per write. */
const WRITE_BATCH = 500;

async function inBatches<T>(items: readonly T[], write: (batch: T[]) => Promise<unknown>): Promise<void> {
	for (let start = 0; start < items.length; start += WRITE_BATCH) await write(items.slice(start, start + WRITE_BATCH));
}

export async function embedTexts(env: CoreEnv, texts: readonly string[], feature: string): Promise<number[][]> {
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
export async function syncCorpusVectors(env: CoreEnv, documents: readonly CorpusDocument[], deletedIds: readonly string[]): Promise<void> {
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
			(batch) => env.CORPUS_VECTORS.upsert(batch),
		);
	}
	const stale = [
		// Each document's list is its document vector, then its chunks.
		...documents.flatMap((document, index) => chunkIdsFrom(document.id, perDocument[index]!.length - 1)),
		...deletedIds.flatMap((id) => [`${id}:d`, ...chunkIdsFrom(id, 0)]),
	];
	await inBatches(stale, (batch) => env.CORPUS_VECTORS.deleteByIds(batch));
}
