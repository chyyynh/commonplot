import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pLimit from 'p-limit';
import { withCoreDb } from '../store/db';
import { AI_SEARCH_ITEM_PREFIX, RESULT_LIMIT_MAX, resourceIdFromAiSearchItemKey, SEARCHABLE_CORPUS_RESOURCE_SQL } from './search-index';

// Cloudflare AI Search allows at most five custom metadata fields per instance.
const CANONICAL_CUSTOM_METADATA = [
	{ field_name: 'published_at', data_type: 'datetime' },
	{ field_name: 'kind', data_type: 'text' },
	{ field_name: 'subject_id', data_type: 'text' },
] as const satisfies NonNullable<AiSearchConfig['custom_metadata']>;

const CANONICAL_SEARCH_CONFIG = {
	cache: false,
	chunk: true,
	// Percent of chunk_size; bge-m3 embeds at most 512 tokens, and AI Search counts CJK differently.
	chunk_overlap: 10,
	chunk_size: 400,
	embedding_model: '@cf/baai/bge-m3',
	fusion_method: 'rrf',
	index_method: { keyword: true, vector: true },
	indexing_options: { keyword_tokenizer: 'trigram' },
	max_num_results: RESULT_LIMIT_MAX,
	score_threshold: 0,
} as const satisfies Partial<AiSearchConfig>;

/** Missing Resources always load; `since` also reloads those changed after that instant. */
type SearchIndexRebuildPayload = { since?: string };
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
const CORPUS_FOLDER_FILTER = JSON.stringify({ folder: AI_SEARCH_ITEM_PREFIX });

async function loadCorpusCount(db: NodePgDatabase): Promise<number> {
	const result = await db.execute<{ count: string }>(sql`
		SELECT COUNT(*)::text AS count
		FROM resources r
		WHERE ${SEARCHABLE_CORPUS_RESOURCE_SQL}
	`);
	const [row] = result.rows;
	const count = Number(row?.count);
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid corpus count: ${row?.count}`);
	return count;
}

async function listCorpusIdsAfter(
	db: NodePgDatabase,
	cursor: string | null,
	since: string | null,
): Promise<Array<{ id: string; changed: boolean }>> {
	// A document carries every translation's title and summary, so a changed translation changes it too.
	const result = await db.execute<{ id: string; changed: boolean }>(sql`
		SELECT r.id::text,
		       (
		         ${since}::timestamptz IS NOT NULL AND (
		           r.updated_at > ${since}::timestamptz
		           OR EXISTS (
		             SELECT 1 FROM resource_derivations d WHERE d.resource_id = r.id AND d.updated_at > ${since}::timestamptz
		           )
		         )
		       ) AS changed
		FROM resources r
		WHERE ${SEARCHABLE_CORPUS_RESOURCE_SQL}
		  AND (${cursor}::uuid IS NULL OR r.id > ${cursor}::uuid)
		ORDER BY r.id
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

/** Deletes a page's stale items and returns the Resources it still indexes. */
async function pruneSearchItemPage(
	instance: AiSearchInstance,
	db: NodePgDatabase,
	page: number,
): Promise<{ deleted: number; kept: string[] }> {
	const listed = await instance.items.list({
		metadata_filter: CORPUS_FOLDER_FILTER,
		page,
		per_page: REINDEX_PAGE_SIZE,
		source: 'builtin',
	});
	const resourceIds = listed.result.map((item) => resourceIdFromAiSearchItemKey(item.key)).filter((id): id is string => id !== null);
	const eligibleIds = await loadEligibleCorpusIds(db, resourceIds);
	const staleItems = listed.result.filter((item) => {
		const resourceId = resourceIdFromAiSearchItemKey(item.key);
		return resourceId === null || !eligibleIds.has(resourceId);
	});
	await pLimit(REINDEX_AI_SEARCH_CONCURRENCY).map(staleItems, (item) => instance.items.delete(item.id));
	return { deleted: staleItems.length, kept: [...eligibleIds] };
}

/** Prunes stale items until a pass deletes none; that clean pass lists every Resource the index holds. */
async function reconcileSearchItems(env: CoreEnv, instance: AiSearchInstance, step: WorkflowStep) {
	let deleted = 0;
	for (let pass = 0; pass < REINDEX_MAX_PRUNE_PASSES; pass++) {
		const pageCount = await step.do(`count-search-item-pages-${pass}`, SHORT_STEP_OPTIONS, () => loadSearchItemPageCount(instance));
		let passDeleted = 0;
		const indexed = new Set<string>();
		// Walking backwards keeps deletions from shifting unvisited items past the cursor.
		for (let lastPage = pageCount; lastPage >= 1; lastPage -= REINDEX_PRUNE_PAGES_PER_STEP) {
			const firstPage = Math.max(1, lastPage - REINDEX_PRUNE_PAGES_PER_STEP + 1);
			const pruned = await step.do(`prune-search-items-${pass}-${firstPage}-${lastPage}`, BATCH_STEP_OPTIONS, () =>
				withCoreDb(env, async (db) => {
					const result = { deleted: 0, kept: [] as string[] };
					for (let page = lastPage; page >= firstPage; page--) {
						const { deleted, kept } = await pruneSearchItemPage(instance, db, page);
						result.deleted += deleted;
						result.kept.push(...kept);
					}
					return result;
				}),
			);
			passDeleted += pruned.deleted;
			for (const id of pruned.kept) indexed.add(id);
		}
		deleted += passDeleted;
		if (passDeleted === 0) return { deleted, passes: pass + 1, indexed };
	}
	throw new Error(`AI Search stale-item reconciliation did not converge after ${REINDEX_MAX_PRUNE_PASSES} passes`);
}

function normalizedCustomMetadata(
	fields: readonly { data_type: string; field_name: string }[] | undefined,
): Array<{ data_type: string; field_name: string }> {
	return (fields ?? [])
		.map((field) => ({ data_type: field.data_type, field_name: field.field_name.toLowerCase() }))
		.sort((left, right) => left.field_name.localeCompare(right.field_name));
}

/** Whether `actual` holds every value `expected` sets; objects compare field by field. */
function holdsValues(actual: unknown, expected: unknown): boolean {
	if (typeof expected !== 'object' || expected === null) return actual === expected;
	if (typeof actual !== 'object' || actual === null) return false;
	return Object.entries(expected).every(([key, value]) => holdsValues((actual as Record<string, unknown>)[key], value));
}

function canonicalSearchInstanceConfigMatches(info: AiSearchInstanceInfo): boolean {
	return (
		holdsValues(info, CANONICAL_SEARCH_CONFIG) &&
		JSON.stringify(normalizedCustomMetadata(info.custom_metadata)) === JSON.stringify(normalizedCustomMetadata(CANONICAL_CUSTOM_METADATA))
	);
}

async function ensureCanonicalSearchInstanceConfig(instance: AiSearchInstance): Promise<'unchanged' | 'updated'> {
	if (canonicalSearchInstanceConfigMatches(await instance.info())) return 'unchanged';
	await instance.update({
		...CANONICAL_SEARCH_CONFIG,
		custom_metadata: [...CANONICAL_CUSTOM_METADATA],
	});
	return 'updated';
}

async function observeSearchIndex(instance: AiSearchInstance, db: NodePgDatabase): Promise<SearchIndexStats & { configReady: boolean }> {
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
		configReady: canonicalSearchInstanceConfigMatches(info),
		error: stats.error ?? 0,
		expectedItems: await loadCorpusCount(db),
		indexedItems,
		outdated: stats.outdated ?? 0,
		queued: stats.queued ?? 0,
		running: stats.running ?? 0,
		skipped: stats.skipped ?? 0,
	};
}

async function retryFailedSearchItems(instance: AiSearchInstance): Promise<number> {
	const listed = await instance.items.list({
		metadata_filter: CORPUS_FOLDER_FILTER,
		page: 1,
		per_page: REINDEX_PAGE_SIZE,
		source: 'builtin',
		status: 'error',
	});
	const items = listed.result.filter((item) => resourceIdFromAiSearchItemKey(item.key) !== null);
	await pLimit(REINDEX_AI_SEARCH_CONCURRENCY).map(items, (item) => instance.items.get(item.id).sync());
	return items.length;
}

async function waitForSearchIndex(env: CoreEnv, instance: AiSearchInstance, step: WorkflowStep) {
	let last: (SearchIndexStats & { configReady: boolean }) | null = null;
	for (let attempt = 0; attempt < REINDEX_READY_POLL_ATTEMPTS; attempt++) {
		last = await step.do(`observe-search-index-${attempt}`, SHORT_STEP_OPTIONS, () =>
			withCoreDb(env, (db) => observeSearchIndex(instance, db)),
		);
		if (last.error > 0) {
			const retried = await step.do(`retry-search-errors-${attempt}`, BATCH_STEP_OPTIONS, () => retryFailedSearchItems(instance));
			if (retried === 0) throw new Error(`AI Search reported errors without retryable Resource items: ${JSON.stringify(last)}`);
		}
		if (last.skipped > 0 || last.outdated > 0) {
			throw new Error(`AI Search finished with terminal items: ${JSON.stringify(last)}`);
		}
		if (
			last.configReady &&
			last.error === 0 &&
			last.queued === 0 &&
			last.running === 0 &&
			last.completed === last.expectedItems &&
			last.indexedItems === last.expectedItems
		) {
			return last;
		}
		if (attempt < REINDEX_READY_POLL_ATTEMPTS - 1) {
			await step.sleep(`wait-search-index-${attempt}`, REINDEX_READY_POLL_INTERVAL);
		}
	}
	throw new Error(`AI Search index did not converge: ${JSON.stringify(last)}`);
}

/** Configures the corpus index, prunes stale items, loads missing or changed Resources and waits for convergence. */
export class SearchIndexRebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		const startedAt = event.timestamp.toISOString();
		const since = event.payload.since ?? null;
		if (since !== null && Number.isNaN(Date.parse(since))) throw new Error(`Invalid rebuild since: ${since}`);
		const instanceConfig = await step.do('ensure-search-config', SHORT_STEP_OPTIONS, () =>
			ensureCanonicalSearchInstanceConfig(this.env.AI_SEARCH),
		);
		const { indexed, ...reconciliation } = await reconcileSearchItems(this.env, this.env.AI_SEARCH, step);
		// The sync queue owns uploads: it reloads each Resource, retries, and wins any race with live writes.
		let cursor: string | null = null;
		let enqueued = 0;
		let pages = 0;
		while (true) {
			const page = await step.do(`enqueue-corpus-page-${pages}`, BATCH_STEP_OPTIONS, () =>
				withCoreDb(this.env, async (db) => {
					const rows = await listCorpusIdsAfter(db, cursor, since);
					const ids = rows.filter((row) => row.changed || !indexed.has(row.id)).map((row) => row.id);
					if (ids.length) await this.env.RESOURCE_SEARCH_SYNC_QUEUE.sendBatch(ids.map((resourceId) => ({ body: { resourceId } })));
					return { cursor: rows.at(-1)?.id ?? null, enqueued: ids.length };
				}),
			);
			if (!page.cursor) break;
			cursor = page.cursor;
			enqueued += page.enqueued;
			pages++;
		}

		const readiness = await waitForSearchIndex(this.env, this.env.AI_SEARCH, step);
		return {
			mode: 'rebuild' as const,
			startedAt,
			since,
			instanceConfig,
			enqueued,
			pages,
			reconciliation,
			readiness,
		};
	}
}
