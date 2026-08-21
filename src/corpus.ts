import { type ContentResourceKind, isContentResourceKind, isResourcePlatform, type ResourcePlatform } from '@core-shared/resource-types';
import { isValidUuid } from '@db/client';

export type PublicResourceSearchInput = {
	query: string;
	limit?: number;
	mode?: 'hybrid' | 'vector';
	filters?: {
		effectiveAfter?: string;
		kinds?: ContentResourceKind[];
		resourcePlatforms?: ResourcePlatform[];
		sourceIds?: string[];
	};
};

type NormalizedSearchFilters = {
	effectiveAfter: Date | null;
	excludeAll: boolean;
	kinds?: ContentResourceKind[];
	resourcePlatforms?: ResourcePlatform[];
	sourceIds?: string[];
};

const RESULT_LIMIT_MAX = 50;
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

function clampLimit(value: number | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return RESULT_LIMIT_MAX;
	return Math.min(Math.max(Math.trunc(value), 1), RESULT_LIMIT_MAX);
}

function normalizeSearchFilters(input: PublicResourceSearchInput): NormalizedSearchFilters {
	const filters = input.filters ?? {};
	const effectiveAfter = filters.effectiveAfter ? new Date(filters.effectiveAfter) : null;
	if (effectiveAfter && Number.isNaN(effectiveAfter.getTime())) throw new Error('Invalid effectiveAfter');
	const sourceIds = filters.sourceIds === undefined ? undefined : [...new Set(filters.sourceIds.map((value) => value.trim()))];
	if (sourceIds?.some((value) => !isValidUuid(value))) throw new Error('Invalid sourceIds');
	const kinds = filters.kinds === undefined ? undefined : [...new Set(filters.kinds)];
	if (kinds?.some((value) => !isContentResourceKind(value))) throw new Error('Invalid resource kinds');
	const resourcePlatforms = filters.resourcePlatforms === undefined ? undefined : [...new Set(filters.resourcePlatforms)];
	if (resourcePlatforms?.some((value) => !isResourcePlatform(value))) throw new Error('Invalid resource platforms');
	return {
		effectiveAfter,
		excludeAll: sourceIds?.length === 0 || kinds?.length === 0 || resourcePlatforms?.length === 0,
		kinds,
		resourcePlatforms,
		sourceIds,
	};
}

function aiSearchFilters(filters: NormalizedSearchFilters): VectorizeVectorMetadataFilter | undefined {
	const metadata: VectorizeVectorMetadataFilter = {};
	if (filters.sourceIds?.length) metadata.source_id = { $in: filters.sourceIds };
	if (filters.kinds?.length) metadata.kind = { $in: filters.kinds };
	if (filters.resourcePlatforms?.length) {
		metadata.resource_platform = { $in: filters.resourcePlatforms.map(corpusResourcePlatformMetadata) };
	}
	if (filters.effectiveAfter) metadata.effective_at = { $gte: filters.effectiveAfter.toISOString() };
	return Object.keys(metadata).length ? metadata : undefined;
}

/** Return AI Search candidates only; Web authoritatively filters and hydrates them from Postgres. */
export async function searchPublicResourceIds(env: CoreEnv, input: PublicResourceSearchInput): Promise<string[]> {
	const query = input.query.trim();
	if (!query) return [];
	const filters = normalizeSearchFilters(input);
	if (filters.excludeAll) return [];
	const retrievalType = input.mode ?? 'hybrid';
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
				...(retrievalType === 'hybrid' ? { boost_by: [{ field: 'effective_at', direction: 'desc' as const }] } : {}),
				...(metadataFilters ? { filters: metadataFilters } : {}),
			},
		},
	});
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const chunk of response.chunks) {
		const id = corpusResourceIdFromItemKey(chunk.item.key);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids.slice(0, clampLimit(input.limit));
}
