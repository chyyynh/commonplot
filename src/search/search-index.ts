import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { RESOURCE_KIND_METADATA, type ResourceKind } from '../contracts/resource';
import { connectCoreDb } from '../store/db';

// Postgres is canonical; AI Search is its derived public-corpus index.
export const AI_SEARCH_ITEM_PREFIX = 'resources/';
const AI_SEARCH_ITEM_SUFFIX = '.md';
const ResourceIdSchema = z.uuid();
const ORIGINAL_CONTENT_MAX_CHARS = 8_000;
const TRANSLATED_CONTENT_MAX_CHARS = 4_000;
const RELATED_SUMMARY_MAX_CHARS = 800;
const RELATED_DOCUMENT_MAX_CHARS = 3_000;
const RELATED_QUERY_MAX_CHARS = 1_000;
const INDEX_TRANSLATION_LANGS = ['en', 'zh-Hant'] as const;
const RESULT_LIMIT_MAX = 50;
const SearchableResourceKindSchema = z.enum(Object.keys(RESOURCE_KIND_METADATA) as ResourceKind[]).exclude(['image']);

export const SEARCHABLE_CORPUS_RESOURCE_SQL = sql`(
	r.kind <> 'image'
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

type CorpusDocument = {
	id: string;
	kind: SearchableResourceKind;
	original_lang: string;
	published_at: string | null;
	source: string | null;
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

const POST_HEADING_MAX_CHARS = 120;

/** Posts have no title, so their document opens with the source line. */
function documentHeading(row: CorpusDocument, original: CorpusTranslationRow): string {
	return row.kind === 'post' ? '' : `# ${requiredDocumentText(original.title, 'title', row.id)}`;
}

function serializeTranslation(translation: CorpusTranslationRow): string {
	return [
		`## ${translation.lang}`,
		translation.title?.trim() ? `Title: ${translation.title.trim()}` : '',
		markdownSection('Summary', translation.summary),
		markdownSection('Content', translation.content),
	]
		.filter(Boolean)
		.join('\n\n');
}

function serializeDocument(row: CorpusDocument): string {
	const original = row.translations.find((translation) => translation.lang === row.original_lang);
	if (!original) throw new Error(`AI Search document ${row.id} is missing its ${row.original_lang} translation`);
	return [documentHeading(row, original), requiredDocumentText(row.source, 'source', row.id), ...row.translations.map(serializeTranslation)]
		.filter(Boolean)
		.join('\n\n');
}

function serializeRelatedDocument(row: CorpusDocument): string {
	const original = row.translations.find((translation) => translation.lang === row.original_lang);
	if (!original) throw new Error(`AI Search document ${row.id} is missing its ${row.original_lang} translation`);
	return [
		documentHeading(row, original),
		`Source: ${requiredDocumentText(row.source, 'source', row.id)}`,
		...row.translations.flatMap((translation) => [
			translation.lang === row.original_lang || !translation.title?.trim() ? '' : `${translation.lang} title: ${translation.title.trim()}`,
			translation.summary?.trim() ? `${translation.lang} summary: ${translation.summary.trim().slice(0, RELATED_SUMMARY_MAX_CHARS)}` : '',
		]),
	]
		.filter(Boolean)
		.join('\n\n')
		.slice(0, RELATED_DOCUMENT_MAX_CHARS);
}

export async function loadCorpusDocuments(db: NodePgDatabase, resourceIds: readonly string[]): Promise<CorpusDocument[]> {
	if (!resourceIds.length) return [];
	const result = await db.execute<CorpusDocument>(sql`
		SELECT r.id::text,
		       r.kind,
		       r.original_lang,
		       r.published_date AS published_at,
		       COALESCE(r.source_name, 'File') AS source,
		       COALESCE((
		         SELECT jsonb_agg(
		           jsonb_build_object(
		             'lang', translation.lang,
		             'title', translation.title,
		             'summary', translation.summary,
		             'content', LEFT(translation.content, CASE WHEN translation.lang = r.original_lang
		               THEN ${ORIGINAL_CONTENT_MAX_CHARS}::integer ELSE ${TRANSLATED_CONTENT_MAX_CHARS}::integer END)
		           )
		           ORDER BY (translation.lang = r.original_lang) DESC, translation.lang
		         )
		         FROM resource_translations translation
		         WHERE translation.resource_id = r.id
		           AND (translation.lang = r.original_lang OR ${inArray(sql`translation.lang`, INDEX_TRANSLATION_LANGS)})
		       ), '[]'::jsonb) AS translations
		FROM resources r
		WHERE ${inArray(sql`r.id`, resourceIds)}
		  AND r.scope = 'corpus'
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		`);
	return result.rows;
}

export async function upsertCorpusItem(env: CoreEnv, document: CorpusDocument): Promise<void> {
	const publishedAt = document.published_at === null ? null : new Date(document.published_at);
	if (publishedAt && Number.isNaN(publishedAt.getTime())) {
		throw new Error(`AI Search document ${document.id} has invalid publication date`);
	}
	const options = {
		metadata: {
			...(publishedAt ? { published_at: publishedAt.toISOString() } : {}),
			kind: document.kind,
		},
	};
	const key = aiSearchItemKey(document.id);
	const uploads = await Promise.allSettled([
		env.AI_SEARCH.items.upload(key, serializeDocument(document), options),
		env.RELATED_SEARCH.items.upload(key, serializeRelatedDocument(document), options),
	]);
	for (const upload of uploads) {
		if (upload.status === 'rejected') throw upload.reason;
	}
}

async function deleteCorpusItem(instance: AiSearchInstance, index: 'corpus' | 'related', resourceId: string): Promise<void> {
	const key = aiSearchItemKey(resourceId);
	const listed = await instance.items.list({ key, source: 'builtin', per_page: 1 });
	const item = listed.result.find((candidate) => candidate.key === key && candidate.source_id === 'builtin');
	if (!item) return;
	await instance.items.delete(item.id);
	console.info({ tag: 'AI_SEARCH', msg: 'Corpus item deleted', index, resource_id: resourceId, item_id: item.id });
}

export async function syncCorpusItem(env: CoreEnv, resourceId: string, document: CorpusDocument | undefined): Promise<void> {
	if (document) {
		await upsertCorpusItem(env, document);
	} else {
		const deletions = await Promise.allSettled([
			deleteCorpusItem(env.AI_SEARCH, 'corpus', resourceId),
			deleteCorpusItem(env.RELATED_SEARCH, 'related', resourceId),
		]);
		for (const deletion of deletions) {
			if (deletion.status === 'rejected') throw deletion.reason;
		}
	}
}

function resourceIdsFromSearchResponse(response: AiSearchSearchResponse): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const chunk of response.chunks) {
		const id = resourceIdFromAiSearchItemKey(chunk.item.key);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

/** Return AI Search candidates only; Web authoritatively filters and hydrates them from Postgres. */
export async function searchPublicResourceIds(env: CoreEnv, input: PublicResourceSearchInput): Promise<string[]> {
	const { query, limit, filters } = PublicResourceSearchInputSchema.parse(input);
	const kinds = filters?.kinds && [...new Set(filters.kinds)];
	// An explicit empty selection matches nothing; missing kinds match everything.
	if (!query || kinds?.length === 0) return [];
	const metadataFilters: VectorizeVectorMetadataFilter = {};
	if (kinds && kinds.length < SearchableResourceKindSchema.options.length) metadataFilters.kind = { $in: kinds };
	if (filters?.publishedAfter) metadataFilters.published_at = { $gte: filters.publishedAfter.toISOString() };
	const response = await env.AI_SEARCH.search({
		query,
		ai_search_options: {
			cache: { enabled: false },
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				retrieval_type: 'hybrid',
				fusion_method: 'rrf',
				keyword_match_mode: 'or',
				match_threshold: 0,
				max_num_results: limit,
				metadata_only: true,
				return_on_failure: true,
				...(Object.keys(metadataFilters).length ? { filters: metadataFilters } : {}),
			},
		},
	});
	return resourceIdsFromSearchResponse(response);
}

/** Search one-vector-per-resource documents so AI Search results map directly to resources. */
export async function searchRelatedResourceIds(env: CoreEnv, input: RelatedResourceSearchInput): Promise<string[]> {
	const { resourceId, limit } = RelatedResourceSearchInputSchema.parse(input);
	const db = await connectCoreDb(env);
	// Recommendation queries need titles and the original summary, not indexed article bodies; a post's text is its title.
	const { rows } = await db.execute<{ titles: (string | null)[]; summary: string | null }>(sql`
		SELECT (array_agg(translation.summary) FILTER (WHERE translation.lang = r.original_lang))[1] AS summary,
		       array_agg(CASE WHEN r.kind = 'post' THEN LEFT(translation.content, ${POST_HEADING_MAX_CHARS}) ELSE translation.title END ORDER BY (translation.lang = r.original_lang) DESC, translation.lang) AS titles
		FROM resources r
		JOIN resource_translations translation ON translation.resource_id = r.id
		  AND (translation.lang = r.original_lang OR ${inArray(sql`translation.lang`, INDEX_TRANSLATION_LANGS)})
		WHERE r.id = ${resourceId}::uuid
		  AND r.scope = 'corpus'
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		GROUP BY r.id
	`);
	const [document] = rows;
	if (!document) return [];
	const query = [
		requiredDocumentText(document.titles[0] ?? null, 'title', resourceId),
		...document.titles.slice(1).map((title) => title?.trim()),
		document.summary?.trim().slice(0, RELATED_SUMMARY_MAX_CHARS),
	]
		.filter(Boolean)
		.join('\n')
		.slice(0, RELATED_QUERY_MAX_CHARS);
	const response = await env.RELATED_SEARCH.search({
		query,
		ai_search_options: {
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				retrieval_type: 'vector',
				match_threshold: 0,
				max_num_results: limit + 1,
				metadata_only: true,
				return_on_failure: false,
			},
		},
	});
	return resourceIdsFromSearchResponse(response)
		.filter((candidateId) => candidateId !== resourceId)
		.slice(0, limit);
}
