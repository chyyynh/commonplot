import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { type ResourceKind, resourceKindsWhere } from '../contracts/resource-kinds';
import { withCoreDb } from '../store/db';
import { kindWhere } from '../store/kind-sql';
import { type CorpusHit, queryCorpusVectors, type SearchPassage } from './corpus-vectors';

// Postgres is canonical; CORPUS_VECTORS is its derived public-corpus index.
const ORIGINAL_CONTENT_MAX_CHARS = 8_000;
const INDEX_TRANSLATION_LANGS = ['en', 'zh-Hant'] as const;
/** The most results one search returns. */
const RESULT_LIMIT_MAX = 50;
const PASSAGES_PER_RESULT = 3;
const SearchableResourceKindSchema = z.enum(resourceKindsWhere('searchable') as [ResourceKind, ...ResourceKind[]]);

/** A corpus Resource `r` that has a searchable document. */
export const SEARCHABLE_CORPUS_RESOURCE_SQL = sql`(
	r.scope = 'corpus'
	AND ${kindWhere(sql`r.kind`, 'searchable')}
	AND (r.kind <> 'file' OR r.file_type = 'application/pdf')
	AND (${kindWhere(sql`r.kind`, 'titled', false)} OR BTRIM(COALESCE(r.title, '')) <> '')
	AND EXISTS (SELECT 1 FROM resource_content body WHERE body.resource_id = r.id AND BTRIM(body.markdown) <> '')
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

export type PublicResourceSearchInput = z.input<typeof PublicResourceSearchInputSchema>;

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
		             'summary', (
		               SELECT derivation.output->>'summary' FROM resource_derivations derivation
		               WHERE derivation.resource_id = r.id AND derivation.kind = 'summary'
		                 AND derivation.lang = translation.lang AND derivation.status = 'done'
		             ),
		             'content', CASE WHEN translation.lang = r.original_lang OR ${kindWhere(sql`r.kind`, 'titled', false)}
		               THEN LEFT(translation.content, ${ORIGINAL_CONTENT_MAX_CHARS}::integer) END
		           )
		           ORDER BY (translation.lang = r.original_lang) DESC, translation.lang
		         )
		         FROM (
		           SELECT r.original_lang AS lang, r.title, body.markdown AS content
		           FROM resource_content body WHERE body.resource_id = r.id
		           UNION ALL
		           SELECT derivation.lang, derivation.output->>'title', derivation.output->>'content'
		           FROM resource_derivations derivation
		           WHERE derivation.resource_id = r.id AND derivation.kind = 'translation' AND derivation.status = 'done'
		             AND ${inArray(sql`derivation.lang`, INDEX_TRANSLATION_LANGS)}
		         ) translation
		       ), '[]'::jsonb) AS translations
		FROM resources r
		WHERE ${inArray(sql`r.id`, resourceIds)}
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		`);
	return result.rows;
}

/**
 * Carriers give way to the Resource they discuss when it is itself searchable and of an allowed
 * kind, so each subject appears once, at its best-ranked position.
 */
async function collapseCarriers(env: CoreEnv, hits: CorpusHit[], kinds?: readonly SearchableResourceKind[]) {
	const carrierIds = hits.filter((hit) => hit.subjectId).map((hit) => hit.id);
	if (!carrierIds.length) return hits;
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
	const collapsed = new Map<string, Omit<CorpusHit, 'subjectId'>>();
	for (const hit of hits) {
		const id = subjects.get(hit.id) ?? hit.id;
		// A carrier's passages quote the carrier, not its subject, so only the subject's own text counts.
		const own = id === hit.id ? hit.passages : [];
		const existing = collapsed.get(id);
		if (!existing) collapsed.set(id, { id, score: hit.score, passages: own });
		else if (own.length) existing.passages = [...existing.passages, ...own].slice(0, PASSAGES_PER_RESULT);
	}
	return [...collapsed.values()];
}

/** Ranked corpus hits, each with its best-matching passages. */
async function searchCorpus(env: CoreEnv, input: PublicResourceSearchInput) {
	const { query, limit, filters } = PublicResourceSearchInputSchema.parse(input);
	const kinds = filters?.kinds && [...new Set(filters.kinds)];
	// An explicit empty selection matches nothing; missing kinds match everything.
	if (!query || kinds?.length === 0) return [];
	const kindFilter = kinds && kinds.length < SearchableResourceKindSchema.options.length ? kinds : undefined;
	const hits = await queryCorpusVectors(env, query, { kinds: kindFilter, publishedAfter: filters?.publishedAfter });
	return (await collapseCarriers(env, hits, kindFilter)).slice(0, limit);
}

/** Return ranked candidates only; Web authoritatively filters and hydrates them from Postgres. */
export async function searchPublicResourceIds(env: CoreEnv, input: PublicResourceSearchInput): Promise<string[]> {
	return (await searchCorpus(env, input)).map((hit) => hit.id);
}

/** Candidates with up to three matched passages each, for a model to judge relevance before reading. */
export async function searchPublicResourcePassages(
	env: CoreEnv,
	input: PublicResourceSearchInput,
): Promise<Array<{ id: string; passages: SearchPassage[] }>> {
	return (await searchCorpus(env, input)).map(({ id, passages }) => ({ id, passages }));
}
