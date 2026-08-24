import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AI_SEARCH_ITEM_PREFIX, resourceIdFromAiSearchItemKey, upsertCorpusItems } from '../search-index';
import { connectCoreDb } from '../shared/db';

// Cloudflare AI Search allows at most five custom metadata fields per instance.
const CANONICAL_CUSTOM_METADATA = [
	{ field_name: 'effective_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'kind', data_type: 'text' },
	{ field_name: 'resource_platform', data_type: 'text' },
] as const satisfies NonNullable<AiSearchConfig['custom_metadata']>;

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
		  AND r.kind NOT IN ('image', 'file')
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
		  AND r.kind NOT IN ('image', 'file')
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

async function syncCorpusPageAfter(
	env: CoreEnv,
	db: NodePgDatabase,
	cursor: string | null,
): Promise<{ cursor: string | null; done: boolean; uploaded: number }> {
	const ids = await listCorpusIdsAfter(db, cursor);
	if (!ids.length) return { cursor, done: true, uploaded: 0 };
	return { cursor: ids.at(-1)!, done: false, uploaded: await uploadCorpusIds(env, db, ids) };
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
		    AND r.kind NOT IN ('image', 'file')
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

async function syncCorpusDeltaAfter(
	env: CoreEnv,
	db: NodePgDatabase,
	startedAt: string,
	cursor: SearchDeltaCursor | null,
): Promise<{ cursor: SearchDeltaCursor | null; done: boolean; uploaded: number }> {
	const rows = await listCorpusDeltaAfter(db, startedAt, cursor);
	if (!rows.length) return { cursor, done: true, uploaded: 0 };
	const last = rows.at(-1)!;
	return {
		cursor: { id: last.id, updatedAt: last.updated_at },
		done: false,
		uploaded: await uploadCorpusIds(
			env,
			db,
			rows.map((row) => row.id),
		),
	};
}

async function loadEligibleCorpusIds(db: NodePgDatabase, resourceIds: readonly string[]): Promise<Set<string>> {
	if (!resourceIds.length) return new Set();
	const result = await db.execute<{ id: string }>(sql`
		SELECT r.id::text
		FROM resources r
		WHERE ${inArray(sql`r.id`, resourceIds)}
		  AND r.scope = 'corpus'
		  AND r.enrichment_status = 'enriched'
		  AND r.kind NOT IN ('image', 'file')
	`);
	return new Set(result.rows.map((row) => row.id));
}

async function loadSearchItemPageCount(env: CoreEnv): Promise<number> {
	const listed = await env.AI_SEARCH.items.list({
		metadata_filter: CORPUS_FOLDER_FILTER,
		page: 1,
		per_page: REINDEX_PAGE_SIZE,
		source: 'builtin',
	});
	const total = listed.result_info?.total_count;
	if (total === undefined) throw new Error('AI Search item listing did not return total_count');
	return Math.ceil(total / REINDEX_PAGE_SIZE);
}

async function pruneSearchItemPage(env: CoreEnv, db: NodePgDatabase, page: number): Promise<number> {
	const listed = await env.AI_SEARCH.items.list({
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
		await Promise.all(staleItems.slice(offset, offset + REINDEX_AI_SEARCH_CONCURRENCY).map((item) => env.AI_SEARCH.items.delete(item.id)));
	}
	return staleItems.length;
}

async function pruneSearchItemPages(env: CoreEnv, db: NodePgDatabase, firstPage: number, lastPage: number): Promise<number> {
	let deleted = 0;
	for (let page = lastPage; page >= firstPage; page--) deleted += await pruneSearchItemPage(env, db, page);
	return deleted;
}

async function reconcileSearchItems(env: CoreEnv, step: WorkflowStep) {
	let deleted = 0;
	for (let pass = 0; pass < REINDEX_MAX_PRUNE_PASSES; pass++) {
		const pageCount = await step.do(`count-search-item-pages-${pass}`, SHORT_STEP_OPTIONS, () => loadSearchItemPageCount(env));
		let passDeleted = 0;
		for (let lastPage = pageCount; lastPage >= 1; lastPage -= REINDEX_PRUNE_PAGES_PER_STEP) {
			const firstPage = Math.max(1, lastPage - REINDEX_PRUNE_PAGES_PER_STEP + 1);
			passDeleted += await step.do(`prune-search-items-${pass}-${firstPage}-${lastPage}`, BATCH_STEP_OPTIONS, async () =>
				pruneSearchItemPages(env, await connectCoreDb(env), firstPage, lastPage),
			);
		}
		deleted += passDeleted;
		if (passDeleted === 0) return { deleted, passes: pass + 1 };
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

function canonicalSearchInstanceConfigMatches(info: AiSearchInstanceInfo): boolean {
	return (
		info.index_method?.vector === true &&
		info.index_method.keyword === true &&
		info.fusion_method === 'rrf' &&
		info.indexing_options?.keyword_tokenizer === 'trigram' &&
		JSON.stringify(normalizedCustomMetadata(info.custom_metadata)) === JSON.stringify(normalizedCustomMetadata(CANONICAL_CUSTOM_METADATA))
	);
}

async function ensureCanonicalSearchInstanceConfig(env: CoreEnv): Promise<'unchanged' | 'updated'> {
	if (canonicalSearchInstanceConfigMatches(await env.AI_SEARCH.info())) return 'unchanged';
	await env.AI_SEARCH.update({
		index_method: { vector: true, keyword: true },
		fusion_method: 'rrf',
		indexing_options: { keyword_tokenizer: 'trigram' },
		custom_metadata: [...CANONICAL_CUSTOM_METADATA],
	});
	return 'updated';
}

async function observeSearchIndex(env: CoreEnv, db: NodePgDatabase): Promise<SearchIndexStats & { configReady: boolean }> {
	const info = await env.AI_SEARCH.info();
	const stats = await env.AI_SEARCH.stats();
	const listed = await env.AI_SEARCH.items.list({
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

async function waitForSearchIndex(env: CoreEnv, step: WorkflowStep) {
	let last: (SearchIndexStats & { configReady: boolean }) | null = null;
	for (let attempt = 0; attempt < REINDEX_READY_POLL_ATTEMPTS; attempt++) {
		last = await step.do(`observe-search-index-${attempt}`, SHORT_STEP_OPTIONS, async () =>
			observeSearchIndex(env, await connectCoreDb(env)),
		);
		if (last.error > 0 || last.skipped > 0 || last.outdated > 0) {
			throw new Error(`AI Search finished with terminal items: ${JSON.stringify(last)}`);
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
			await step.sleep(`wait-search-index-${attempt}`, REINDEX_READY_POLL_INTERVAL);
		}
	}
	throw new Error(`AI Search index did not converge: ${JSON.stringify(last)}`);
}

export class SearchIndexRebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		const startedAt = event.timestamp.toISOString();
		const instanceConfig = await step.do('ensure-search-config', SHORT_STEP_OPTIONS, () => ensureCanonicalSearchInstanceConfig(this.env));
		let cursor: string | null = null;
		let uploaded = 0;
		let pages = 0;
		while (true) {
			const result = await step.do(`upload-corpus-page-${pages}`, BATCH_STEP_OPTIONS, async () =>
				syncCorpusPageAfter(this.env, await connectCoreDb(this.env), cursor),
			);
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
			const result = await step.do(`upload-delta-page-${deltaPages}`, BATCH_STEP_OPTIONS, async () =>
				syncCorpusDeltaAfter(this.env, await connectCoreDb(this.env), startedAt, deltaCursor),
			);
			if (result.done) break;
			deltaCursor = result.cursor;
			deltaUploaded += result.uploaded;
			deltaPages++;
		}

		const reconciliation = await reconcileSearchItems(this.env, step);
		const readiness = await waitForSearchIndex(this.env, step);
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
