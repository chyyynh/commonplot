import {
	type ContentResourceIdentity,
	type ContentResourceKind,
	isContentResourceIdentity,
	isContentResourceKind,
	isResourcePlatform,
	parseResourceIdentity,
	RESOURCE_CATEGORIES,
	type ResourceCategory,
	type ResourcePlatform,
} from '@core-shared/resource-types';
import { type CoreDb, isValidUuid, queryRows, textArraySql, uuidArraySql, withCoreDb } from '@db/client';
import { contentResourceIdentitySql, resourceDisplaySourceSql, resourceIdentityFilterSql } from '@db/resource-identity-sql';
import { type SQL, sql } from 'drizzle-orm';

type ResourceSummary = {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source: string;
	summary?: string;
	tags?: string[];
} & ContentResourceIdentity;

export type ResourceSearchInput = {
	query: string;
	limit?: number;
	filters?: ResourceSearchFilters;
};

type ResourceSearchFilters = {
	categories?: ResourceCategory[];
	effectiveAfter?: string;
	effectiveBefore?: string;
	kinds?: ContentResourceKind[];
	resourcePlatforms?: ResourcePlatform[];
	sourceIds?: string[];
};

export type RelatedResourceSearchInput = {
	seed: { id: string; type: 'resource' };
	limit?: number;
	offset?: number;
};

interface ResourceSearchRow {
	id: string;
	title: string | null;
	url: string | null;
	kind: string;
	resource_platform: string | null;
	published_date: Date | string | null;
	source: string | null;
	summary: string | null;
	tags: string[] | null;
}

const RESULT_LIMIT = 10;
const RESULT_LIMIT_MAX = 50;
const RELATED_LIMIT_DEFAULT = 12;
const RELATED_LIMIT_MAX = RESULT_LIMIT_MAX;
const SUMMARY_MAX = 500;
const SEARCH_SOURCE_MAX = 256;
const SEARCH_TAGS_MAX = 8;
const SEARCH_TAG_MAX = 64;
const SEARCH_TITLE_MAX = 512;
const SEARCH_URL_MAX = 2_048;
export const CORPUS_ITEM_PREFIX = 'resources/';
const CORPUS_ITEM_SUFFIX = '.md';
const NULL_RESOURCE_PLATFORM_METADATA = 'none';

export function corpusItemKey(resourceId: string): string {
	return `${CORPUS_ITEM_PREFIX}${resourceId}${CORPUS_ITEM_SUFFIX}`;
}

export function corpusResourceIdFromItemKey(key: string): string | null {
	if (!key.startsWith(CORPUS_ITEM_PREFIX) || !key.endsWith(CORPUS_ITEM_SUFFIX)) return null;
	const resourceId = key.slice(CORPUS_ITEM_PREFIX.length, -CORPUS_ITEM_SUFFIX.length);
	return isValidUuid(resourceId) ? resourceId : null;
}

export function corpusResourcePlatformMetadata(resourcePlatform: ResourcePlatform): string {
	return resourcePlatform ?? NULL_RESOURCE_PLATFORM_METADATA;
}

type NormalizedSearchFilters = {
	categories?: ResourceCategory[];
	effectiveAfter: Date | null;
	effectiveBefore: Date | null;
	excludeAll: boolean;
	kinds?: ContentResourceKind[];
	resourcePlatforms?: ResourcePlatform[];
	sourceIds?: string[];
};

function aiSearchFilters(filters: NormalizedSearchFilters): VectorizeVectorMetadataFilter | undefined {
	const metadata: VectorizeVectorMetadataFilter = {};
	if (filters.sourceIds?.length) metadata.source_id = { $in: filters.sourceIds };
	if (filters.categories?.length) metadata.category = { $in: filters.categories };
	if (filters.kinds?.length) metadata.kind = { $in: filters.kinds };
	if (filters.resourcePlatforms?.length) {
		metadata.resource_platform = { $in: filters.resourcePlatforms.map(corpusResourcePlatformMetadata) };
	}
	if (filters.effectiveAfter || filters.effectiveBefore) {
		metadata.effective_at = {
			...(filters.effectiveAfter ? { $gte: filters.effectiveAfter.toISOString() } : {}),
			...(filters.effectiveBefore ? { $lte: filters.effectiveBefore.toISOString() } : {}),
		};
	}
	return Object.keys(metadata).length ? metadata : undefined;
}

async function searchCorpusRanks(
	env: CoreEnv,
	query: string,
	filters: NormalizedSearchFilters,
	profile: 'discovery' | 'related' = 'discovery',
): Promise<Array<{ id: string; score: number }>> {
	const retrievalType = profile === 'related' ? 'vector' : 'hybrid';
	const metadataFilters = aiSearchFilters(filters);
	const response = await env.AI_SEARCH.search({
		query,
		ai_search_options: {
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				retrieval_type: retrievalType,
				...(retrievalType === 'hybrid' ? { fusion_method: 'rrf' as const } : {}),
				keyword_match_mode: 'or',
				max_num_results: RESULT_LIMIT_MAX,
				metadata_only: true,
				return_on_failure: false,
				...(profile === 'related' ? {} : { boost_by: [{ field: 'effective_at', direction: 'desc' as const }] }),
				...(metadataFilters ? { filters: metadataFilters } : {}),
			},
		},
	});
	const ranks = new Map<string, { id: string; score: number }>();
	for (const [index, chunk] of response.chunks.entries()) {
		const id = corpusResourceIdFromItemKey(chunk.item.key);
		if (!id || ranks.has(id)) continue;
		// Consumers hydrate rows in PostgreSQL, so return a unique order-preserving
		// score instead of the tied scores commonly produced by RRF.
		ranks.set(id, { id, score: response.chunks.length - index });
	}
	return [...ranks.values()];
}

async function filterReadableCorpusRanks(
	env: CoreEnv,
	ranks: readonly { id: string; score: number }[],
	filters: NormalizedSearchFilters,
): Promise<Array<{ id: string; score: number }>> {
	const ids = ranks.map((rank) => rank.id).filter(isValidUuid);
	if (ids.length === 0) return [];
	const readableIds = await withCoreDb(env, async (db) => {
		const rows = await queryRows<{ id: string }>(
			db,
			sql`
				SELECT r.id::text
				FROM resources r
				WHERE r.id = ANY(${uuidArraySql(ids)})
				  AND ${corpusEnrichedSql()}${searchFiltersSql(filters)}
			`,
		);
		return new Set(rows.map((row) => row.id));
	});
	return ranks.filter((rank) => readableIds.has(rank.id));
}

export async function searchCorpusResourceRanks(env: CoreEnv, input: ResourceSearchInput): Promise<Array<{ id: string; score: number }>> {
	const query = input.query.trim();
	if (!query) return [];
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT_MAX);
	const filters = normalizeSearchFilters(input);
	if (filters.excludeAll) return [];
	const ranks = await searchCorpusRanks(env, query, filters);
	return (await filterReadableCorpusRanks(env, ranks, filters)).slice(0, limit);
}

export async function relatedCorpusResourceIds(env: CoreEnv, input: RelatedResourceSearchInput): Promise<string[]> {
	const seed = { id: input.seed.id.trim(), type: input.seed.type };
	if (!seed.id) return [];
	const limit = clampInt(input.limit, 1, RELATED_LIMIT_MAX, RELATED_LIMIT_DEFAULT);
	const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	const seedText = await withCoreDb(env, (db) => relatedSeedText(db, seed.id));
	if (!seedText) return [];
	const filters = normalizeSearchFilters({ query: seedText });
	const ranks = await searchCorpusRanks(env, seedText, filters, 'related');
	const readableRanks = await filterReadableCorpusRanks(env, ranks, filters);
	return readableRanks
		.map((rank) => rank.id)
		.filter((id) => id !== seed.id)
		.slice(offset, offset + limit);
}

export async function searchCorpusResources(env: CoreEnv, input: ResourceSearchInput): Promise<ResourceSummary[]> {
	const query = input.query.trim();
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT);
	const filters = normalizeSearchFilters(input);
	if (filters.excludeAll) return [];
	const rankedIds = query ? (await searchCorpusRanks(env, query, filters)).map((rank) => rank.id) : null;
	return withCoreDb(env, async (db) => {
		if (rankedIds) {
			const candidateIds = rankedIds.filter(isValidUuid);
			if (candidateIds.length === 0) return [];
			const rows = await queryRows<ResourceSearchRow>(
				db,
				sql`
					SELECT ${resourceSearchSelect()}
					FROM resources r
					${resourceSearchJoins()}
					WHERE r.id = ANY(${uuidArraySql(candidateIds)})
						AND ${corpusEnrichedSql()}${searchFiltersSql(filters)}
					ORDER BY array_position(${uuidArraySql(candidateIds)}, r.id)
					LIMIT ${limit}
				`,
			);
			return rows.map(formatSummary);
		}

		const rows = await queryRows<ResourceSearchRow>(
			db,
			sql`
				SELECT ${resourceSearchSelect()}
				FROM resources r
				${resourceSearchJoins()}
				WHERE ${corpusEnrichedSql()}${searchFiltersSql(filters)}
				ORDER BY ${recencySql()} DESC, r.id DESC
				LIMIT ${limit}
			`,
		);
		return rows.map(formatSummary);
	});
}

function clampInt(value: number | undefined, min: number, max: number, defaultValue: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function optionalSearchDate(value: string | undefined, field: string): Date | null {
	if (value === undefined) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}`);
	return date;
}

function normalizeSearchFilters(input: ResourceSearchInput): NormalizedSearchFilters {
	const filters = input.filters ?? {};
	const effectiveAfter = optionalSearchDate(filters.effectiveAfter, 'effectiveAfter');
	const effectiveBefore = optionalSearchDate(filters.effectiveBefore, 'effectiveBefore');
	if (effectiveAfter && effectiveBefore && effectiveAfter > effectiveBefore)
		throw new Error('effectiveAfter must not exceed effectiveBefore');
	const sourceIds = filters.sourceIds === undefined ? undefined : [...new Set(filters.sourceIds.map((value) => value.trim()))];
	if (sourceIds?.some((value) => !isValidUuid(value))) throw new Error('Invalid sourceIds');
	const kinds = filters.kinds === undefined ? undefined : [...new Set(filters.kinds)];
	if (kinds?.some((value) => !isContentResourceKind(value))) throw new Error('Invalid resource kinds');
	const resourcePlatforms = filters.resourcePlatforms === undefined ? undefined : [...new Set(filters.resourcePlatforms)];
	if (resourcePlatforms?.some((value) => !isResourcePlatform(value))) throw new Error('Invalid resource platforms');
	const categories = filters.categories === undefined ? undefined : [...new Set(filters.categories)];
	if (categories?.some((value) => !(RESOURCE_CATEGORIES as readonly string[]).includes(value))) {
		throw new Error('Invalid resource categories');
	}
	return {
		categories,
		effectiveAfter,
		effectiveBefore,
		excludeAll: sourceIds?.length === 0 || kinds?.length === 0 || resourcePlatforms?.length === 0 || categories?.length === 0,
		kinds,
		resourcePlatforms,
		sourceIds,
	};
}

function resourceIdentityForRow(resource: { id: string; kind: string; resource_platform: string | null }): ContentResourceIdentity {
	const identity = parseResourceIdentity(resource.kind, resource.resource_platform);
	if (!identity) {
		throw new Error(`Corpus resource ${resource.id} has invalid persisted identity ${resource.kind} / ${resource.resource_platform}`);
	}
	if (!isContentResourceIdentity(identity)) {
		throw new Error(`Corpus resource ${resource.id} has non-content kind ${identity.kind}`);
	}
	return identity;
}

function formatSummary(resource: ResourceSearchRow): ResourceSummary {
	const summary = resource.summary ?? undefined;
	const publishedDate = optionalIsoDate(resource.published_date, resource.id);
	const identity = resourceIdentityForRow(resource);
	return {
		...identity,
		id: resource.id,
		title: requiredCorpusText(resource.title, 'title', resource.id).slice(0, SEARCH_TITLE_MAX),
		url: requiredCorpusText(resource.url, 'url', resource.id).slice(0, SEARCH_URL_MAX),
		...(publishedDate ? { publishedDate } : {}),
		source: requiredCorpusText(resource.source, 'source', resource.id).slice(0, SEARCH_SOURCE_MAX),
		summary: summary ? summary.slice(0, SUMMARY_MAX) : undefined,
		tags: resource.tags?.slice(0, SEARCH_TAGS_MAX).map((tag) => tag.slice(0, SEARCH_TAG_MAX)) ?? undefined,
	};
}

function requiredCorpusText(value: string | null, field: string, resourceId: string): string {
	const text = value?.trim();
	if (!text) throw new Error(`Corpus resource ${resourceId} is missing ${field}`);
	return text;
}

function optionalIsoDate(value: Date | string | null, resourceId: string): string | undefined {
	if (value === null) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Corpus resource ${resourceId} has invalid date`);
	return date.toISOString();
}

async function relatedSeedText(db: CoreDb, resourceId: string): Promise<string | null> {
	if (!isValidUuid(resourceId)) return null;
	const rows = await queryRows<{ title: string | null; summary: string | null; tags: string[] | null }>(
		db,
		sql`
			SELECT rt.title, rt.summary, r.tags
			FROM resources r
			LEFT JOIN LATERAL (
				SELECT title, summary
				FROM resources_localized
				WHERE id = r.id AND lang = r.original_lang
				LIMIT 1
			) rt ON TRUE
			WHERE r.id = ${resourceId}::uuid AND ${corpusEnrichedSql()}
			LIMIT 1
		`,
	);
	const row = rows[0];
	return row ? [row.title, row.summary, row.tags?.join(' ')].filter(Boolean).join('\n').slice(0, 4000) : null;
}

function recencySql(): SQL {
	return sql`COALESCE(r.published_date, r.scraped_date, r.created_at)`;
}

function corpusEnrichedSql(): SQL {
	return sql`r.scope = 'corpus'
		AND r.enrichment_status = 'enriched'
		AND ${contentResourceIdentitySql({
			kind: sql`r.kind`,
			resourcePlatform: sql`r.resource_platform`,
		})}`;
}

function searchFiltersSql(filters: NormalizedSearchFilters): SQL {
	return sql`${filters.effectiveAfter ? sql` AND ${recencySql()} >= ${filters.effectiveAfter}` : sql``}
			${filters.effectiveBefore ? sql` AND ${recencySql()} <= ${filters.effectiveBefore}` : sql``}
			${filters.sourceIds ? sql` AND r.source_id = ANY(${uuidArraySql(filters.sourceIds)})` : sql``}
			AND ${resourceIdentityFilterSql(
				{
					kind: sql`r.kind`,
					resourcePlatform: sql`r.resource_platform`,
				},
				{ kinds: filters.kinds, resourcePlatforms: filters.resourcePlatforms },
			)}
			${filters.categories ? sql` AND r.category = ANY(${textArraySql(filters.categories)})` : sql``}`;
}

function resourceSearchJoins(): SQL {
	return sql`
		LEFT JOIN sources monitored_source ON monitored_source.id = r.source_id
		LEFT JOIN LATERAL (
			SELECT title, summary
			FROM resources_localized
			WHERE id = r.id AND lang = r.original_lang
			LIMIT 1
		) rt ON TRUE
	`;
}

function resourceSearchSelect(): SQL {
	return sql`
		r.id::text,
		rt.title AS title,
		r.url,
		r.kind,
		r.resource_platform,
		${recencySql()} AS published_date,
		${resourceDisplaySourceSql({
			creatorName: sql`COALESCE(r.creators->0->>'literal', CONCAT_WS(' ', r.creators->0->>'given', r.creators->0->>'family'))`,
			kind: sql`r.kind`,
			monitoredSourceName: sql`monitored_source.name`,
			resourcePlatform: sql`r.resource_platform`,
		})} AS source,
		rt.summary AS summary,
		r.tags
	`;
}
