import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { RESOURCE_KIND_METADATA, RESOURCE_PLATFORMS, type ResourceKind, type ResourcePlatform } from './shared/resource';

// Postgres is canonical; AI Search is its derived public-corpus index.
export const AI_SEARCH_ITEM_PREFIX = 'resources/';
const AI_SEARCH_ITEM_SUFFIX = '.md';
const NULL_RESOURCE_PLATFORM_METADATA = 'none';
const ResourceIdSchema = z.uuid();
const ORIGINAL_CONTENT_MAX_CHARS = 8_000;
const TRANSLATED_CONTENT_MAX_CHARS = 4_000;
const RELATED_SUMMARY_MAX_CHARS = 800;
const RELATED_DOCUMENT_MAX_CHARS = 3_000;
const RELATED_QUERY_MAX_CHARS = 1_000;
const INDEX_TRANSLATION_LANGS = ['en', 'zh-Hant'] as const;
const RESULT_LIMIT_MAX = 50;
const RELATED_RESULT_LIMIT_MAX = RESULT_LIMIT_MAX - 1;
const SEARCHABLE_RESOURCE_KIND_COUNT = Object.keys(RESOURCE_KIND_METADATA).filter((kind) => kind !== 'image').length;

export const SEARCHABLE_CORPUS_RESOURCE_SQL = sql`(
	r.kind <> 'image'
	AND (r.kind <> 'file' OR r.file_type = 'application/pdf')
	AND EXISTS (
		SELECT 1 FROM resource_translations original
		WHERE original.resource_id = r.id AND original.lang = r.original_lang
		  AND BTRIM(COALESCE(original.title, '')) <> ''
		  AND BTRIM(COALESCE(original.content, '')) <> ''
	)
)`;

type SearchableResourceKind = Exclude<ResourceKind, 'image'>;

export type PublicResourceSearchInput = {
	query: string;
	limit: number;
	mode?: 'hybrid' | 'vector';
	filters?: {
		publishedAfter?: Date;
		kinds?: SearchableResourceKind[];
		resourcePlatforms?: (ResourcePlatform | null)[];
	};
};

export type RelatedResourceSearchInput = {
	resourceId: string;
	limit: number;
};

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
	keywords: string[] | null;
};

type CorpusDocument = {
	id: string;
	source_id: string | null;
	kind: SearchableResourceKind;
	resource_platform: ResourcePlatform | null;
	original_lang: string;
	published_at: Date | string | null;
	tags: string[] | null;
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

function serializeTranslation(translation: CorpusTranslationRow, originalLang: string): string {
	const contentLimit = translation.lang === originalLang ? ORIGINAL_CONTENT_MAX_CHARS : TRANSLATED_CONTENT_MAX_CHARS;
	return [
		`## ${translation.lang}`,
		translation.title?.trim() ? `Title: ${translation.title.trim()}` : '',
		translation.keywords?.length ? `Keywords: ${translation.keywords.join(', ')}` : '',
		markdownSection('Summary', translation.summary),
		markdownSection('Content', translation.content?.slice(0, contentLimit)),
	]
		.filter(Boolean)
		.join('\n\n');
}

function serializeDocument(row: CorpusDocument): string {
	const original = row.translations.find((translation) => translation.lang === row.original_lang);
	if (!original) throw new Error(`AI Search document ${row.id} is missing its ${row.original_lang} translation`);
	return [
		`# ${requiredDocumentText(original.title, 'title', row.id)}`,
		requiredDocumentText(row.source, 'source', row.id),
		row.tags?.length ? `Tags: ${row.tags.join(', ')}` : '',
		...row.translations.map((translation) => serializeTranslation(translation, row.original_lang)),
	]
		.filter(Boolean)
		.join('\n\n');
}

function serializeRelatedDocument(row: CorpusDocument): string {
	const original = row.translations.find((translation) => translation.lang === row.original_lang);
	if (!original) throw new Error(`AI Search document ${row.id} is missing its ${row.original_lang} translation`);
	return [
		`# ${requiredDocumentText(original.title, 'title', row.id)}`,
		`Source: ${requiredDocumentText(row.source, 'source', row.id)}`,
		row.tags?.length ? `Tags: ${row.tags.join(', ')}` : '',
		...row.translations.flatMap((translation) => [
			translation.lang === row.original_lang || !translation.title?.trim() ? '' : `${translation.lang} title: ${translation.title.trim()}`,
			translation.keywords?.length ? `${translation.lang} keywords: ${translation.keywords.join(', ')}` : '',
			translation.summary?.trim() ? `${translation.lang} summary: ${translation.summary.trim().slice(0, RELATED_SUMMARY_MAX_CHARS)}` : '',
		]),
	]
		.filter(Boolean)
		.join('\n\n')
		.slice(0, RELATED_DOCUMENT_MAX_CHARS);
}

function serializeRelatedQuery(row: CorpusDocument): string {
	const original = row.translations.find((translation) => translation.lang === row.original_lang);
	if (!original) throw new Error(`AI Search document ${row.id} is missing its ${row.original_lang} translation`);
	return [
		requiredDocumentText(original.title, 'title', row.id),
		row.tags?.join(', '),
		...row.translations.flatMap((translation) => [
			translation.lang === row.original_lang ? '' : translation.title?.trim(),
			translation.keywords?.join(', '),
		]),
	]
		.filter(Boolean)
		.join('\n')
		.slice(0, RELATED_QUERY_MAX_CHARS);
}

export async function loadCorpusDocuments(db: NodePgDatabase, resourceIds: readonly string[]): Promise<CorpusDocument[]> {
	if (!resourceIds.length) return [];
	const result = await db.execute<CorpusDocument>(sql`
		SELECT r.id::text,
		       r.source_id::text,
		       r.kind,
		       r.resource_platform,
		       r.original_lang,
		       r.published_date AS published_at,
		       r.tags,
		       COALESCE(r.source_name, 'File') AS source,
		       COALESCE((
		         SELECT jsonb_agg(
		           jsonb_build_object(
		             'lang', translation.lang,
		             'title', translation.title,
		             'summary', translation.summary,
		             'content', LEFT(translation.content, CASE WHEN translation.lang = r.original_lang
		               THEN ${ORIGINAL_CONTENT_MAX_CHARS}::integer ELSE ${TRANSLATED_CONTENT_MAX_CHARS}::integer END),
		             'keywords', translation.keywords
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
			...(document.source_id ? { source_id: document.source_id } : {}),
			kind: document.kind,
			resource_platform: document.resource_platform ?? NULL_RESOURCE_PLATFORM_METADATA,
		},
	};
	const key = aiSearchItemKey(document.id);
	await Promise.all([
		env.AI_SEARCH.items.upload(key, serializeDocument(document), options),
		env.RELATED_SEARCH.items.upload(key, serializeRelatedDocument(document), options),
	]);
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
		await Promise.all([deleteCorpusItem(env.AI_SEARCH, 'corpus', resourceId), deleteCorpusItem(env.RELATED_SEARCH, 'related', resourceId)]);
	}
}

/** Null means an explicitly empty selection; undefined means unrestricted search. */
function aiSearchFilters(input: PublicResourceSearchInput['filters']): VectorizeVectorMetadataFilter | null | undefined {
	const filters = input ?? {};
	const publishedAfter = filters.publishedAfter ?? null;
	if (publishedAfter && (!(publishedAfter instanceof Date) || Number.isNaN(publishedAfter.getTime()))) {
		throw new Error('Invalid publishedAfter');
	}
	const kinds = filters.kinds === undefined ? undefined : [...new Set(filters.kinds)];
	if (kinds?.some((value) => !Object.hasOwn(RESOURCE_KIND_METADATA, value) || String(value) === 'image')) {
		throw new Error('Invalid resource kinds');
	}
	const resourcePlatforms = filters.resourcePlatforms === undefined ? undefined : [...new Set(filters.resourcePlatforms)];
	if (resourcePlatforms?.some((value) => value !== null && (typeof value !== 'string' || !Object.hasOwn(RESOURCE_PLATFORMS, value)))) {
		throw new Error('Invalid resource platforms');
	}
	if (kinds?.length === 0 || resourcePlatforms?.length === 0) return null;
	const metadata: VectorizeVectorMetadataFilter = {};
	if (kinds?.length && kinds.length < SEARCHABLE_RESOURCE_KIND_COUNT) metadata.kind = { $in: kinds };
	if (resourcePlatforms?.length)
		metadata.resource_platform = { $in: resourcePlatforms.map((platform) => platform ?? NULL_RESOURCE_PLATFORM_METADATA) };
	if (publishedAfter) metadata.published_at = { $gte: publishedAfter.toISOString() };
	return Object.keys(metadata).length ? metadata : undefined;
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
	if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > RESULT_LIMIT_MAX) {
		throw new Error(`Public Resource search limit must be 1-${RESULT_LIMIT_MAX}`);
	}
	const query = input.query.trim();
	if (!query) return [];
	const metadataFilters = aiSearchFilters(input.filters);
	if (metadataFilters === null) return [];
	const retrievalType = input.mode ?? 'hybrid';
	const response = await env.AI_SEARCH.search({
		query,
		ai_search_options: {
			cache: { enabled: false },
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				retrieval_type: retrievalType,
				...(retrievalType === 'hybrid' ? { fusion_method: 'rrf' as const } : {}),
				keyword_match_mode: 'or',
				match_threshold: 0,
				max_num_results: input.limit,
				metadata_only: true,
				return_on_failure: true,
				...(metadataFilters ? { filters: metadataFilters } : {}),
			},
		},
	});
	return resourceIdsFromSearchResponse(response);
}

/** Search one-vector-per-resource documents so AI Search results map directly to resources. */
export async function searchRelatedResourceIds(env: CoreEnv, db: NodePgDatabase, input: RelatedResourceSearchInput): Promise<string[]> {
	const resourceId = ResourceIdSchema.parse(input.resourceId);
	if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > RELATED_RESULT_LIMIT_MAX) {
		throw new Error(`Related Resource search limit must be 1-${RELATED_RESULT_LIMIT_MAX}`);
	}
	const [document] = await loadCorpusDocuments(db, [resourceId]);
	if (!document) return [];
	const response = await env.RELATED_SEARCH.search({
		query: serializeRelatedQuery(document),
		ai_search_options: {
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				retrieval_type: 'vector',
				match_threshold: 0,
				max_num_results: input.limit + 1,
				metadata_only: true,
				return_on_failure: false,
			},
		},
	});
	return resourceIdsFromSearchResponse(response)
		.filter((candidateId) => candidateId !== resourceId)
		.slice(0, input.limit);
}
