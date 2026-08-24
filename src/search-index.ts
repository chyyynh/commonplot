import type { RESOURCE_TYPES } from '@core-shared/resource';
import type { CoreDb } from '@db/connection';
import { resourceDisplaySourceSql } from '@db/display-source-sql';
import { inArray, sql } from 'drizzle-orm';

// Postgres is canonical; AI Search is its derived public-corpus index.
export const AI_SEARCH_ITEM_PREFIX = 'resources/';
const AI_SEARCH_ITEM_SUFFIX = '.md';
const NULL_RESOURCE_PLATFORM_METADATA = 'none';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGINAL_CONTENT_MAX_CHARS = 8_000;
const TRANSLATED_CONTENT_MAX_CHARS = 4_000;
const INDEX_TRANSLATION_LANGS = ['en', 'zh-Hant'] as const;

export function isValidUuid(value: string): boolean {
	return UUID_RE.test(value);
}

function aiSearchItemKey(resourceId: string): string {
	return `${AI_SEARCH_ITEM_PREFIX}${resourceId}${AI_SEARCH_ITEM_SUFFIX}`;
}

export function resourceIdFromAiSearchItemKey(key: string): string | null {
	if (!key.startsWith(AI_SEARCH_ITEM_PREFIX) || !key.endsWith(AI_SEARCH_ITEM_SUFFIX)) return null;
	const resourceId = key.slice(AI_SEARCH_ITEM_PREFIX.length, -AI_SEARCH_ITEM_SUFFIX.length);
	return isValidUuid(resourceId) ? resourceId : null;
}

export function aiSearchResourcePlatformMetadata(
	resourcePlatform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null,
): string {
	return resourcePlatform ?? NULL_RESOURCE_PLATFORM_METADATA;
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
	kind: Exclude<keyof typeof RESOURCE_TYPES, 'image' | 'file'>;
	resource_platform: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null;
	original_lang: string;
	effective_at: Date | string | null;
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

function documentEffectiveAt(row: CorpusDocument): string | undefined {
	if (row.effective_at === null) return undefined;
	const date = new Date(row.effective_at);
	if (Number.isNaN(date.getTime())) throw new Error(`AI Search document ${row.id} has invalid effective date`);
	return date.toISOString();
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

async function loadCorpusDocuments(db: CoreDb, resourceIds: readonly string[]): Promise<CorpusDocument[]> {
	if (!resourceIds.length) return [];
	const result = await db.execute<CorpusDocument>(sql`
		SELECT r.id::text,
		       r.source_id::text,
		       r.kind,
		       r.resource_platform,
		       r.original_lang,
		       COALESCE(r.published_date, r.scraped_date, r.created_at) AS effective_at,
		       r.tags,
		       ${resourceDisplaySourceSql({
							creatorName: sql`COALESCE(r.creators->0->>'literal', CONCAT_WS(' ', r.creators->0->>'given', r.creators->0->>'family'))`,
							kind: sql`r.kind`,
							monitoredSourceName: sql`s.name`,
							resourcePlatform: sql`r.resource_platform`,
						})} AS source,
		       COALESCE((
		         SELECT jsonb_agg(
		           jsonb_build_object(
		             'lang', translation.lang,
		             'title', translation.title,
		             'summary', translation.summary,
		             'content', translation.content,
		             'keywords', translation.keywords
		           )
		           ORDER BY (translation.lang = r.original_lang) DESC, translation.lang
		         )
		         FROM resource_translations translation
		         WHERE translation.resource_id = r.id
		           AND (translation.lang = r.original_lang OR ${inArray(sql`translation.lang`, INDEX_TRANSLATION_LANGS)})
		       ), '[]'::jsonb) AS translations
		FROM resources r
		LEFT JOIN sources s ON s.id = r.source_id
		WHERE ${inArray(sql`r.id`, resourceIds)}
		  AND r.scope = 'corpus'
		  AND r.enrichment_status = 'enriched'
		  AND r.kind NOT IN ('image', 'file')
		`);
	return result.rows;
}

function corpusItemMetadata(document: CorpusDocument): Record<string, unknown> {
	const effectiveAt = documentEffectiveAt(document);
	return {
		...(effectiveAt ? { effective_at: effectiveAt } : {}),
		...(document.source_id ? { source_id: document.source_id } : {}),
		kind: document.kind,
		resource_platform: aiSearchResourcePlatformMetadata(document.resource_platform),
	};
}

async function uploadCorpusDocument(env: CoreEnv, document: CorpusDocument): Promise<void> {
	await env.AI_SEARCH.items.upload(aiSearchItemKey(document.id), serializeDocument(document), {
		metadata: corpusItemMetadata(document),
	});
}

export async function upsertCorpusItems(env: CoreEnv, db: CoreDb, resourceIds: readonly string[]): Promise<number> {
	const documents = await loadCorpusDocuments(db, resourceIds);
	await Promise.all(documents.map((document) => uploadCorpusDocument(env, document)));
	return documents.length;
}

async function deleteCorpusItem(env: CoreEnv, resourceId: string): Promise<void> {
	const key = aiSearchItemKey(resourceId);
	const listed = await env.AI_SEARCH.items.list({ key, source: 'builtin', per_page: 1 });
	const item = listed.result.find((candidate) => candidate.key === key && candidate.source_id === 'builtin');
	if (!item) return;
	await env.AI_SEARCH.items.delete(item.id);
	console.info({ tag: 'AI_SEARCH', msg: 'Corpus item deleted', resource_id: resourceId, item_id: item.id });
}

export async function syncCorpusItem(env: CoreEnv, db: CoreDb, resourceId: string): Promise<void> {
	if (!isValidUuid(resourceId)) return;
	if ((await upsertCorpusItems(env, db, [resourceId])) === 0) await deleteCorpusItem(env, resourceId);
}
