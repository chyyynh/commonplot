import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AI_SEARCH_ITEM_PREFIX, resourceIdFromAiSearchItemKey, SEARCHABLE_CORPUS_RESOURCE_SQL, upsertCorpusItems } from '../search-index';
import { connectCoreDb } from '../shared/db';

// Cloudflare AI Search allows at most five custom metadata fields per instance.
const CANONICAL_CUSTOM_METADATA = [
	{ field_name: 'published_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'kind', data_type: 'text' },
	{ field_name: 'resource_platform', data_type: 'text' },
] as const satisfies NonNullable<AiSearchConfig['custom_metadata']>;

type SearchIndexName = 'corpus' | 'related';

const CANONICAL_SEARCH_CONFIGS = {
	corpus: {
		cache: false,
		chunk: true,
		chunk_overlap: 12,
		chunk_size: 512,
		embedding_model: '@cf/qwen/qwen3-embedding-0.6b',
		fusion_method: 'rrf',
		index_method: { keyword: true, vector: true },
		indexing_options: { keyword_tokenizer: 'trigram' },
		max_num_results: 50,
		score_threshold: 0,
	},
	related: {
		cache: false,
		chunk: true,
		chunk_overlap: 0,
		chunk_size: 4_096,
		embedding_model: '@cf/qwen/qwen3-embedding-0.6b',
		index_method: { keyword: false, vector: true },
		max_num_results: 50,
		score_threshold: 0,
	},
} as const satisfies Record<SearchIndexName, Partial<AiSearchConfig>>;

type SearchIndexRebuildPayload = Record<string, never>;
type SearchDeltaCursor = { id: string; updatedAt: string };
type SearchDeltaRow = { id: string; updated_at: string };
type SearchIndexStats = {
	completed: number;
	error: number;
	expectedItems: number;
	indexedItems: number;
	outdated: number;
	queued: number;
	running: number;
	skipped: number;
};

const REINDEX_PAGE_SIZE = 50;
const REINDEX_AI_SEARCH_CONCURRENCY = 5;
const REINDEX_MAX_PRUNE_PASSES = 3;
const REINDEX_PRUNE_PAGES_PER_STEP = 10;
const REINDEX_READY_POLL_ATTEMPTS = 72;
const REINDEX_READY_POLL_INTERVAL = '10 minutes';
const STEP_RETRIES = { limit: 5, delay: '10 seconds', backoff: 'exponential' } as const;
const SHORT_STEP_OPTIONS = { retries: STEP_RETRIES, timeout: '60 seconds' } as const;
const BATCH_STEP_OPTIONS = { retries: STEP_RETRIES, timeout: '300 seconds' } as const;
const UTC_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const CORPUS_FOLDER_FILTER = JSON.stringify({ folder: AI_SEARCH_ITEM_PREFIX });

async function loadCorpusCount(db: NodePgDatabase): Promise<number> {
	const result = await db.execute<{ count: string }>(sql`
		SELECT COUNT(*)::text AS count
		FROM resources r
		WHERE r.scope = 'corpus'
		  AND r.enrichment_status = 'enriched'
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
	`);
	const [row] = result.rows;
	const count = Number(row?.count);
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid corpus count: ${row?.count}`);
	return count;
}

async function listCorpusIdsAfter(db: NodePgDatabase, cursor: string | null): Promise<string[]> {
	const result = await db.execute<{ id: string }>(sql`
		SELECT r.id::text
		FROM resources r
		WHERE r.scope = 'corpus'
		  AND r.enrichment_status = 'enriched'
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		  AND (${cursor}::uuid IS NULL OR r.id > ${cursor}::uuid)
		ORDER BY r.id
		LIMIT ${REINDEX_PAGE_SIZE}
	`);
	return result.rows.map((row) => row.id);
}

async function uploadCorpusIds(env: CoreEnv, db: NodePgDatabase, ids: readonly string[]): Promise<number> {
	let uploaded = 0;
	for (let offset = 0; offset < ids.length; offset += REINDEX_AI_SEARCH_CONCURRENCY) {
		const batch = ids.slice(offset, offset + REINDEX_AI_SEARCH_CONCURRENCY);
		const batchUploaded = await upsertCorpusItems(env, db, batch);
		if (batchUploaded !== batch.length) {
			throw new Error(`Corpus changed while rebuilding: loaded ${batchUploaded}/${batch.length} documents`);
		}
		uploaded += batchUploaded;
	}
	return uploaded;
}

async function listCorpusDeltaAfter(db: NodePgDatabase, startedAt: string, cursor: SearchDeltaCursor | null): Promise<SearchDeltaRow[]> {
	const result = await db.execute<SearchDeltaRow>(sql`
		WITH changed_resources AS (
		  SELECT r.id,
		         GREATEST(r.updated_at, COALESCE(MAX(translation.updated_at), r.updated_at)) AT TIME ZONE 'UTC' AS updated_at
		  FROM resources r
		  LEFT JOIN resource_translations translation ON translation.resource_id = r.id
		  WHERE r.scope = 'corpus'
		    AND r.enrichment_status = 'enriched'
		    AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		  GROUP BY r.id, r.updated_at
		)
		SELECT id::text, to_char(updated_at, ${UTC_TIMESTAMP_FORMAT}) AS updated_at
		FROM changed_resources
		WHERE updated_at >= ${startedAt}::timestamptz
		  AND (
		    ${cursor?.updatedAt ?? null}::timestamptz IS NULL
		    OR updated_at > ${cursor?.updatedAt ?? null}::timestamptz
		    OR (updated_at = ${cursor?.updatedAt ?? null}::timestamptz AND id > ${cursor?.id ?? null}::uuid)
		  )
		ORDER BY updated_at, id
		LIMIT ${REINDEX_PAGE_SIZE}
	`);
	return result.rows;
}

async function loadEligibleCorpusIds(db: NodePgDatabase, resourceIds: readonly string[]): Promise<Set<string>> {
	if (!resourceIds.length) return new Set();
	const result = await db.execute<{ id: string }>(sql`
		SELECT r.id::text
		FROM resources r
		WHERE ${inArray(sql`r.id`, resourceIds)}
		  AND r.scope = 'corpus'
		  AND r.enrichment_status = 'enriched'
		  AND ${SEARCHABLE_CORPUS_RESOURCE_SQL}
	`);
	return new Set(result.rows.map((row) => row.id));
}

async function loadSearchItemPageCount(instance: AiSearchInstance): Promise<number> {
	const listed = await instance.items.list({
		metadata_filter: CORPUS_FOLDER_FILTER,
		page: 1,
		per_page: REINDEX_PAGE_SIZE,
		source: 'builtin',
	});
	const total = listed.result_info?.total_count;
	if (total === undefined) throw new Error('AI Search item listing did not return total_count');
	return Math.ceil(total / REINDEX_PAGE_SIZE);
}

async function pruneSearchItemPage(instance: AiSearchInstance, db: NodePgDatabase, page: number): Promise<number> {
	const listed = await instance.items.list({
		metadata_filter: CORPUS_FOLDER_FILTER,
		page,
		per_page: REINDEX_PAGE_SIZE,
		source: 'builtin',
	});
	const ownedItems = listed.result.filter((item) => item.source_id === 'builtin');
	const resourceIds = ownedItems.map((item) => resourceIdFromAiSearchItemKey(item.key)).filter((id): id is string => id !== null);
	const eligibleIds = await loadEligibleCorpusIds(db, resourceIds);
	const staleItems = ownedItems.filter((item) => {
		const resourceId = resourceIdFromAiSearchItemKey(item.key);
		return resourceId === null || !eligibleIds.has(resourceId);
	});
	for (let offset = 0; offset < staleItems.length; offset += REINDEX_AI_SEARCH_CONCURRENCY) {
		await Promise.all(staleItems.slice(offset, offset + REINDEX_AI_SEARCH_CONCURRENCY).map((item) => instance.items.delete(item.id)));
	}
	return staleItems.length;
}

async function reconcileSearchItems(env: CoreEnv, instance: AiSearchInstance, index: SearchIndexName, step: WorkflowStep) {
	let deleted = 0;
	for (let pass = 0; pass < REINDEX_MAX_PRUNE_PASSES; pass++) {
		const pageCount = await step.do(`count-${index}-search-item-pages-${pass}`, SHORT_STEP_OPTIONS, () =>
			loadSearchItemPageCount(instance),
		);
		let passDeleted = 0;
		for (let lastPage = pageCount; lastPage >= 1; lastPage -= REINDEX_PRUNE_PAGES_PER_STEP) {
			const firstPage = Math.max(1, lastPage - REINDEX_PRUNE_PAGES_PER_STEP + 1);
			passDeleted += await step.do(`prune-${index}-search-items-${pass}-${firstPage}-${lastPage}`, BATCH_STEP_OPTIONS, async () => {
				const db = await connectCoreDb(env);
				let deleted = 0;
				for (let page = lastPage; page >= firstPage; page--) {
					deleted += await pruneSearchItemPage(instance, db, page);
				}
				return deleted;
			});
		}
		deleted += passDeleted;
		if (passDeleted === 0) return { deleted, passes: pass + 1 };
	}
	throw new Error(`${index} AI Search stale-item reconciliation did not converge after ${REINDEX_MAX_PRUNE_PASSES} passes`);
}

function normalizedCustomMetadata(
	fields: readonly { data_type: string; field_name: string }[] | undefined,
): Array<{ data_type: string; field_name: string }> {
	return (fields ?? [])
		.map((field) => ({ data_type: field.data_type, field_name: field.field_name.toLowerCase() }))
		.sort((left, right) => left.field_name.localeCompare(right.field_name));
}

function canonicalSearchInstanceConfigMatches(info: AiSearchInstanceInfo, index: SearchIndexName): boolean {
	const expected = CANONICAL_SEARCH_CONFIGS[index];
	if (
		info.chunk !== expected.chunk ||
		info.embedding_model !== expected.embedding_model ||
		info.index_method?.vector !== true ||
		info.max_num_results !== expected.max_num_results ||
		JSON.stringify(normalizedCustomMetadata(info.custom_metadata)) !== JSON.stringify(normalizedCustomMetadata(CANONICAL_CUSTOM_METADATA))
	) {
		return false;
	}
	if (index === 'related') {
		const related = CANONICAL_SEARCH_CONFIGS.related;
		return (
			info.cache === related.cache &&
			info.chunk_size === related.chunk_size &&
			info.chunk_overlap === related.chunk_overlap &&
			info.index_method.keyword === false &&
			info.score_threshold === related.score_threshold
		);
	}
	const corpus = CANONICAL_SEARCH_CONFIGS.corpus;
	return (
		info.cache === corpus.cache &&
		info.chunk_size === corpus.chunk_size &&
		info.chunk_overlap === corpus.chunk_overlap &&
		info.index_method.keyword === true &&
		info.fusion_method === corpus.fusion_method &&
		info.indexing_options?.keyword_tokenizer === corpus.indexing_options.keyword_tokenizer &&
		info.score_threshold === corpus.score_threshold
	);
}

async function ensureCanonicalSearchInstanceConfig(instance: AiSearchInstance, index: SearchIndexName): Promise<'unchanged' | 'updated'> {
	if (canonicalSearchInstanceConfigMatches(await instance.info(), index)) return 'unchanged';
	await instance.update({
		...CANONICAL_SEARCH_CONFIGS[index],
		custom_metadata: [...CANONICAL_CUSTOM_METADATA],
	});
	return 'updated';
}

async function observeSearchIndex(
	instance: AiSearchInstance,
	index: SearchIndexName,
	db: NodePgDatabase,
): Promise<SearchIndexStats & { configReady: boolean }> {
	const info = await instance.info();
	const stats = await instance.stats();
	const listed = await instance.items.list({
		metadata_filter: CORPUS_FOLDER_FILTER,
		page: 1,
		per_page: 1,
		source: 'builtin',
	});
	const indexedItems = listed.result_info?.total_count;
	if (indexedItems === undefined) throw new Error('AI Search readiness listing did not return total_count');
	return {
		completed: stats.completed ?? 0,
		configReady: canonicalSearchInstanceConfigMatches(info, index),
		error: stats.error ?? 0,
		expectedItems: await loadCorpusCount(db),
		indexedItems,
		outdated: stats.outdated ?? 0,
		queued: stats.queued ?? 0,
		running: stats.running ?? 0,
		skipped: stats.skipped ?? 0,
	};
}

async function retryFailedSearchItems(env: CoreEnv, instance: AiSearchInstance): Promise<number> {
	const listed = await instance.items.list({
		metadata_filter: CORPUS_FOLDER_FILTER,
		page: 1,
		per_page: REINDEX_PAGE_SIZE,
		source: 'builtin',
		status: 'error',
	});
	const resourceIds = [
		...new Set(listed.result.map((item) => resourceIdFromAiSearchItemKey(item.key)).filter((id): id is string => id !== null)),
	];
	if (!resourceIds.length) return 0;
	await uploadCorpusIds(env, await connectCoreDb(env), resourceIds);
	return resourceIds.length;
}

async function waitForSearchIndex(env: CoreEnv, instance: AiSearchInstance, index: SearchIndexName, step: WorkflowStep) {
	let last: (SearchIndexStats & { configReady: boolean }) | null = null;
	for (let attempt = 0; attempt < REINDEX_READY_POLL_ATTEMPTS; attempt++) {
		last = await step.do(`observe-${index}-search-index-${attempt}`, SHORT_STEP_OPTIONS, async () =>
			observeSearchIndex(instance, index, await connectCoreDb(env)),
		);
		if (last.error > 0) {
			const retried = await step.do(`retry-${index}-search-errors-${attempt}`, BATCH_STEP_OPTIONS, () =>
				retryFailedSearchItems(env, instance),
			);
			if (retried === 0) throw new Error(`${index} AI Search reported errors without retryable Resource items: ${JSON.stringify(last)}`);
		}
		if (last.skipped > 0 || last.outdated > 0) {
			throw new Error(`${index} AI Search finished with terminal items: ${JSON.stringify(last)}`);
		}
		if (
			last.configReady &&
			last.queued === 0 &&
			last.running === 0 &&
			last.completed === last.expectedItems &&
			last.indexedItems === last.expectedItems
		) {
			return last;
		}
		if (attempt < REINDEX_READY_POLL_ATTEMPTS - 1) {
			await step.sleep(`wait-${index}-search-index-${attempt}`, REINDEX_READY_POLL_INTERVAL);
		}
	}
	throw new Error(`${index} AI Search index did not converge: ${JSON.stringify(last)}`);
}

export class SearchIndexRebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		const startedAt = event.timestamp.toISOString();
		const instanceConfig = await step.do('ensure-search-configs', SHORT_STEP_OPTIONS, async () => ({
			corpus: await ensureCanonicalSearchInstanceConfig(this.env.AI_SEARCH, 'corpus'),
			related: await ensureCanonicalSearchInstanceConfig(this.env.RELATED_SEARCH, 'related'),
		}));
		let cursor: string | null = null;
		let uploaded = 0;
		let pages = 0;
		while (true) {
			const result = await step.do(`upload-corpus-page-${pages}`, BATCH_STEP_OPTIONS, async () => {
				const db = await connectCoreDb(this.env);
				const ids = await listCorpusIdsAfter(db, cursor);
				if (!ids.length) return { cursor, done: true, uploaded: 0 };
				return { cursor: ids.at(-1)!, done: false, uploaded: await uploadCorpusIds(this.env, db, ids) };
			});
			if (result.done) break;
			if (!result.cursor) throw new Error(`AI Search rebuild page ${pages} did not return a cursor`);
			cursor = result.cursor;
			uploaded += result.uploaded;
			pages++;
		}

		let deltaCursor: SearchDeltaCursor | null = null;
		let deltaUploaded = 0;
		let deltaPages = 0;
		while (true) {
			const result = await step.do(`upload-delta-page-${deltaPages}`, BATCH_STEP_OPTIONS, async () => {
				const db = await connectCoreDb(this.env);
				const rows = await listCorpusDeltaAfter(db, startedAt, deltaCursor);
				if (!rows.length) return { cursor: deltaCursor, done: true, uploaded: 0 };
				const last = rows.at(-1)!;
				return {
					cursor: { id: last.id, updatedAt: last.updated_at },
					done: false,
					uploaded: await uploadCorpusIds(
						this.env,
						db,
						rows.map((row) => row.id),
					),
				};
			});
			if (result.done) break;
			deltaCursor = result.cursor;
			deltaUploaded += result.uploaded;
			deltaPages++;
		}

		const reconciliation = {
			corpus: await reconcileSearchItems(this.env, this.env.AI_SEARCH, 'corpus', step),
			related: await reconcileSearchItems(this.env, this.env.RELATED_SEARCH, 'related', step),
		};
		const readiness = {
			corpus: await waitForSearchIndex(this.env, this.env.AI_SEARCH, 'corpus', step),
			related: await waitForSearchIndex(this.env, this.env.RELATED_SEARCH, 'related', step),
		};
		return {
			mode: 'rebuild' as const,
			startedAt,
			instanceConfig,
			uploaded,
			pages,
			deltaUploaded,
			deltaPages,
			reconciliation,
			readiness,
		};
	}
}
