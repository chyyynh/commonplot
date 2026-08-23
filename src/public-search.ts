import { RESOURCE_TYPES } from '@core-shared/resource';
import { aiSearchResourcePlatformMetadata, isValidUuid, resourceIdFromAiSearchItemKey } from './ai-search';

export type PublicResourceSearchInput = {
	query: string;
	mode?: 'hybrid' | 'vector';
	filters?: {
		effectiveAfter?: Date;
		kinds?: Exclude<keyof typeof RESOURCE_TYPES, 'image' | 'file'>[];
		resourcePlatforms?: ((typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES]['platforms'][number]['name'] | null)[];
		sourceIds?: string[];
	};
};

type NormalizedSearchFilters = Omit<NonNullable<PublicResourceSearchInput['filters']>, 'effectiveAfter'> & {
	effectiveAfter: Date | null;
	excludeAll: boolean;
};

const RESULT_LIMIT_MAX = 50;

function normalizeSearchFilters(input: PublicResourceSearchInput): NormalizedSearchFilters {
	const filters = input.filters ?? {};
	const effectiveAfter = filters.effectiveAfter ?? null;
	if (effectiveAfter && (!(effectiveAfter instanceof Date) || Number.isNaN(effectiveAfter.getTime()))) {
		throw new Error('Invalid effectiveAfter');
	}
	const sourceIds = filters.sourceIds === undefined ? undefined : [...new Set(filters.sourceIds.map((value) => value.trim()))];
	if (sourceIds?.some((value) => !isValidUuid(value))) throw new Error('Invalid sourceIds');
	const kinds = filters.kinds === undefined ? undefined : [...new Set(filters.kinds)];
	if (kinds?.some((value) => !Object.hasOwn(RESOURCE_TYPES, value) || ['image', 'file'].includes(value))) {
		throw new Error('Invalid resource kinds');
	}
	const resourcePlatforms = filters.resourcePlatforms === undefined ? undefined : [...new Set(filters.resourcePlatforms)];
	if (
		resourcePlatforms?.some(
			(value) => value !== null && !Object.values(RESOURCE_TYPES).some(({ platforms }) => platforms.some(({ name }) => name === value)),
		)
	) {
		throw new Error('Invalid resource platforms');
	}
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
		metadata.resource_platform = { $in: filters.resourcePlatforms.map(aiSearchResourcePlatformMetadata) };
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
		const id = resourceIdFromAiSearchItemKey(chunk.item.key);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}
