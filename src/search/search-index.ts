import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { RESOURCE_KIND_METADATA, type ResourceKind } from '../contracts/resource';
import { withCoreDb } from '../store/db';

// Postgres is canonical; AI Search is its derived public-corpus index.
export const AI_SEARCH_ITEM_PREFIX = 'resources/';
const AI_SEARCH_ITEM_SUFFIX = '.md';
const ResourceIdSchema = z.uuid();
const ORIGINAL_CONTENT_MAX_CHARS = 8_000;
const INDEX_TRANSLATION_LANGS = ['en', 'zh-Hant'] as const;
/** Queries go to the index as written and come back in index order, never cached. */
const PLAIN_SEARCH_OPTIONS = {
	cache: { enabled: false },
	query_rewrite: { enabled: false },
	reranking: { enabled: false },
} as const;
/** The most results one AI Search query returns. */
export const RESULT_LIMIT_MAX = 50;
const SearchableResourceKindSchema = z.enum(Object.keys(RESOURCE_KIND_METADATA) as ResourceKind[]).exclude(['image']);

/** A corpus Resource `r` that has a searchable document. */
export const SEARCHABLE_CORPUS_RESOURCE_SQL = sql`(
	r.scope = 'corpus'
	AND r.kind <> 'image'
	AND (r.kind <> 'file' OR r.file_type = 'application/pdf')
	AND EXISTS (
		SELECT 1 FROM resource_translations original
		WHERE original.resource_id = r.id AND original.lang = r.original_lang
		  AND (r.kind = 'post' OR BTRIM(COALESCE(original.title, '')) <> '')
		  AND BTRIM(COALESCE(original.content, '')) <> ''
	)
)`;

type SearchableResourceKind = z.infer<typeof SearchableResourceKindSchema>;

const PublicResourceSearchInputSchema = z.strictObject({
	query: z.string().trim(),
	limit: z.int().min(1).max(RESULT_LIMIT_MAX),
	filters: z
		.strictObject({
			publishedAfter: z.date().optional(),
			kinds: z.array(SearchableResourceKindSchema).optional(),
		})
		.optional(),
});

const RelatedResourceSearchInputSchema = z.strictObject({
	resourceId: ResourceIdSchema.toLowerCase(),
	limit: z
		.int()
		.min(1)
		.max(RESULT_LIMIT_MAX - 1),
});

export type PublicResourceSearchInput = z.input<typeof PublicResourceSearchInputSchema>;
export type RelatedResourceSearchInput = z.input<typeof RelatedResourceSearchInputSchema>;

function aiSearchItemKey(resourceId: string): string {
	return `${AI_SEARCH_ITEM_PREFIX}${resourceId}${AI_SEARCH_ITEM_SUFFIX}`;
}

export function resourceIdFromAiSearchItemKey(key: string): string | null {
	if (!key.startsWith(AI_SEARCH_ITEM_PREFIX) || !key.endsWith(AI_SEARCH_ITEM_SUFFIX)) return null;
	const resourceId = key.slice(AI_SEARCH_ITEM_PREFIX.length, -AI_SEARCH_ITEM_SUFFIX.length);
	return z.validate(ResourceIdSchema, resourceId) ? resourceId : null;
}

type CorpusTranslationRow = {
	lang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
};

export type CorpusDocument = {
	id: string;
	kind: SearchableResourceKind;
	original_lang: string;
	published_at: string | null;
	source: string | null;
	subject_id: string | null;
	translations: CorpusTranslationRow[];
};

function markdownSection(label: string, value: string | null | undefined): string {
	return value?.trim() ? `\n## ${label}\n\n${value.trim()}\n` : '';
}

function requiredDocumentText(value: string | null, field: string, resourceId: string): string {
	const text = value?.trim();
	if (!text) throw new Error(`AI Search document ${resourceId} is missing ${field}`);
	return text;
}

/** Posts have no title, so their document opens with the source line. */
function documentHeading(row: CorpusDocument, original: CorpusTranslationRow): string {
	return row.kind === 'post' ? '' : `# ${requiredDocumentText(original.title, 'title', row.id)}`;
}

function serializeTranslation(translation: CorpusTranslationRow): string {
	return [
		`## ${translation.lang}`,
		translation.title?.trim() ? `Title: ${translation.title.trim()}` : '',
		markdownSection('Summary', translation.summary),
	]
		.filter(Boolean)
		.join('\n\n');
}

/**
 * Every language's title and summary lead, so the first chunk carries them; only the original body
 * follows, since the embedding model already matches queries across languages.
 */
function serializeDocument(row: CorpusDocument): string {
	const original = row.translations.find((translation) => translation.lang === row.original_lang);
	if (!original) throw new Error(`AI Search document ${row.id} is missing its ${row.original_lang} translation`);
	return [
		documentHeading(row, original),
		requiredDocumentText(row.source, 'source', row.id),
		...row.translations.map(serializeTranslation),
		markdownSection('Content', original.content),
	]
		.filter(Boolean)
		.join('\n\n');
}

export async function loadCorpusDocuments(db: NodePgDatabase, resourceIds: readonly string[]): Promise<CorpusDocument[]> {
	if (!resourceIds.length) return [];
	const result = await db.execute<CorpusDocument>(sql`
		SELECT r.id::text,
		       r.kind,
		       r.original_lang,
		       r.published_date AS published_at,
		       COALESCE(r.source_name, 'File') AS source,
		       r.subject_resource_id::text AS subject_id,
		       COALESCE((
		         SELECT jsonb_agg(
		           jsonb_build_object(
		             'lang', translation.lang,
		             'title', translation.title,
		             'summary', translation.summary,
		             'content', CASE WHEN translation.lang = r.original_lang OR r.kind = 'post'
		               THEN LEFT(translation.content, ${ORIGINAL_CONTENT_MAX_CHARS}::integer) END
		           )
		           ORDER BY (translation.lang = r.original_lang) DESC, translation.lang
		         )
		         FROM resource_translations translation
		         WHERE translation.resource_id = r.id
		           AND (translation.lang = r.original_lang OR ${inArray(sql`translation.lang`, INDEX_TRANSLATION_LANGS)})
		       ), '[]'::jsonb) AS translations
		FROM resources r
		WHERE ${inArray(sql`r.id`, resourceIds)}
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		`);
	return result.rows;
}

async function upsertCorpusItem(env: CoreEnv, document: CorpusDocument): Promise<void> {
	const publishedAt = document.published_at === null ? null : new Date(document.published_at);
	if (publishedAt && Number.isNaN(publishedAt.getTime())) {
		throw new Error(`AI Search document ${document.id} has invalid publication date`);
	}
	const options = {
		metadata: {
			...(publishedAt ? { published_at: publishedAt.toISOString() } : {}),
			kind: document.kind,
			// Carriers such as HN threads and reposts name the Resource they discuss.
			...(document.subject_id ? { subject_id: document.subject_id } : {}),
		},
	};
	await env.AI_SEARCH.items.upload(aiSearchItemKey(document.id), serializeDocument(document), options);
}

async function deleteCorpusItem(env: CoreEnv, resourceId: string): Promise<void> {
	const key = aiSearchItemKey(resourceId);
	const listed = await env.AI_SEARCH.items.list({ key, source: 'builtin', per_page: 1 });
	const item = listed.result.find((candidate) => candidate.key === key);
	if (!item) return;
	await env.AI_SEARCH.items.delete(item.id);
	console.info({ tag: 'AI_SEARCH', msg: 'Corpus item deleted', resource_id: resourceId, item_id: item.id });
}

export async function syncCorpusItem(env: CoreEnv, resourceId: string, document: CorpusDocument | undefined): Promise<void> {
	if (document) await upsertCorpusItem(env, document);
	else await deleteCorpusItem(env, resourceId);
}

/** A matched chunk of a Resource's indexed text, trimmed for a model to judge relevance. */
export type SearchPassage = { text: string; score: number };
const PASSAGES_PER_RESULT = 3;
const PASSAGE_MAX_CHARS = 500;

type SearchHit = { id: string; subjectId: string | null; score: number; passages: SearchPassage[] };

/** One hit per Resource at its best chunk's rank; later chunks of it add passages. */
function hitsFromSearchResponse(response: AiSearchSearchResponse): SearchHit[] {
	const hits = new Map<string, SearchHit>();
	for (const chunk of response.chunks) {
		const id = resourceIdFromAiSearchItemKey(chunk.item.key);
		if (!id) continue;
		let hit = hits.get(id);
		if (!hit) {
			const subjectId = chunk.item.metadata?.subject_id;
			hit = { id, subjectId: typeof subjectId === 'string' ? subjectId : null, score: chunk.score, passages: [] };
			hits.set(id, hit);
		}
		const text = chunk.text?.replace(/\s+/g, ' ').trim();
		if (text && hit.passages.length < PASSAGES_PER_RESULT)
			hit.passages.push({ text: text.slice(0, PASSAGE_MAX_CHARS), score: chunk.score });
	}
	return [...hits.values()];
}

/**
 * Carriers give way to the Resource they discuss when it is itself searchable and of an allowed
 * kind, so each subject appears once, at its best-ranked position.
 */
async function collapseCarriers(
	env: CoreEnv,
	hits: SearchHit[],
	kinds?: readonly SearchableResourceKind[],
): Promise<Array<{ id: string; score: number; passages: SearchPassage[] }>> {
	const carrierIds = hits.filter((hit) => hit.subjectId).map((hit) => hit.id);
	if (!carrierIds.length) return hits.map(({ id, score, passages }) => ({ id, score, passages }));
	const { rows } = await withCoreDb(env, (db) =>
		db.execute<{ id: string; subject_id: string }>(sql`
		SELECT carrier.id::text, r.id::text AS subject_id
		FROM resources carrier
		JOIN resources r ON r.id = carrier.subject_resource_id
		WHERE ${inArray(sql`carrier.id`, carrierIds)}
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		  ${kinds ? sql`AND ${inArray(sql`r.kind`, kinds)}` : sql``}
	`),
	);
	const subjects = new Map(rows.map((row) => [row.id, row.subject_id]));
	const collapsed = new Map<string, { id: string; score: number; passages: SearchPassage[] }>();
	for (const hit of hits) {
		const id = subjects.get(hit.id) ?? hit.id;
		// A carrier's chunks quote the carrier, not its subject, so only the subject's own text counts.
		const own = id === hit.id ? hit.passages : [];
		const existing = collapsed.get(id);
		if (!existing) collapsed.set(id, { id, score: hit.score, passages: own });
		else if (own.length) existing.passages = [...existing.passages, ...own].slice(0, PASSAGES_PER_RESULT);
	}
	return [...collapsed.values()];
}

/** Ranked corpus hits; with passages, AI Search returns chunk text too, a larger response. */
async function searchCorpus(env: CoreEnv, input: PublicResourceSearchInput, withPassages: boolean) {
	const { query, limit, filters } = PublicResourceSearchInputSchema.parse(input);
	const kinds = filters?.kinds && [...new Set(filters.kinds)];
	// An explicit empty selection matches nothing; missing kinds match everything.
	if (!query || kinds?.length === 0) return [];
	const metadataFilters: VectorizeVectorMetadataFilter = {};
	const kindFilter = kinds && kinds.length < SearchableResourceKindSchema.options.length ? kinds : undefined;
	if (kindFilter) metadataFilters.kind = { $in: kindFilter };
	if (filters?.publishedAfter) metadataFilters.published_at = { $gte: filters.publishedAfter.toISOString() };
	const response = await env.AI_SEARCH.search({
		query,
		ai_search_options: {
			...PLAIN_SEARCH_OPTIONS,
			retrieval: {
				retrieval_type: 'hybrid',
				fusion_method: 'rrf',
				keyword_match_mode: 'or',
				match_threshold: 0,
				// Results are chunks, and one long resource can fill several; ask for
				// the most AI Search returns so deduping still leaves `limit` resources.
				max_num_results: RESULT_LIMIT_MAX,
				metadata_only: !withPassages,
				return_on_failure: true,
				...(Object.keys(metadataFilters).length ? { filters: metadataFilters } : {}),
			},
		},
	});
	return (await collapseCarriers(env, hitsFromSearchResponse(response), kindFilter)).slice(0, limit);
}

/** Return AI Search candidates only; Web authoritatively filters and hydrates them from Postgres. */
export async function searchPublicResourceIds(env: CoreEnv, input: PublicResourceSearchInput): Promise<string[]> {
	return (await searchCorpus(env, input, false)).map((hit) => hit.id);
}

/** Candidates with up to three matched passages each, for a model to judge relevance before reading. */
export async function searchPublicResourcePassages(
	env: CoreEnv,
	input: PublicResourceSearchInput,
): Promise<Array<{ id: string; passages: SearchPassage[] }>> {
	return (await searchCorpus(env, input, true)).map(({ id, passages }) => ({ id, passages }));
}

/** The corpus nearest a Resource in meaning, by its own recommendation vector, nearest first with each one's similarity. */
export async function searchRelatedResources(
	env: CoreEnv,
	input: RelatedResourceSearchInput,
): Promise<Array<{ id: string; score: number }>> {
	const { resourceId, limit } = RelatedResourceSearchInputSchema.parse(input);
	// With all metadata Vectorize returns at most 50 matches, the Resource itself among them.
	const { matches } = await env.RESOURCE_VECTORS.queryById(resourceId, { topK: RESULT_LIMIT_MAX, returnMetadata: 'all' });
	const self = matches.find((match) => match.id === resourceId);
	// A Resource without a vector yet has no neighbours to offer.
	if (!self) return [];
	const subjectIdOf = (match: VectorizeMatch) => (typeof match.metadata?.subject_id === 'string' ? match.metadata.subject_id : null);
	const subjectId = subjectIdOf(self);
	// Vectorize scores quantized vectors, which reads every similarity low by about the same factor, its own score
	// included; dividing by that restores cosine similarity to within about 0.02.
	const hits = matches
		.filter((match) => match !== self)
		.map((match) => ({ id: match.id, subjectId: subjectIdOf(match), score: Math.min(1, match.score / self.score), passages: [] }));
	return (await collapseCarriers(env, hits))
		.filter((hit) => hit.id !== resourceId && hit.id !== subjectId)
		.slice(0, limit)
		.map(({ id, score }) => ({ id, score }));
}
