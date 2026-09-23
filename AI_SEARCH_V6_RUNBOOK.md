# AI Search v6 operations

This runbook covers the active public Resource index. Historical rollout and
one-shot repair procedures remain in Git history, not in the current operator
surface.

## Active contract

| Role | Active resource |
| --- | --- |
| Serving binding | `AI_SEARCH → newsence-corpus-v6` |
| Rebuild binding | `SEARCH_INDEX_REBUILD_WORKFLOW` |
| Physical Workflow | `newsence-search-index-rebuild` |
| Entrypoint | `SearchIndexRebuildWorkflow` |
| Current runner | `search-index-rebuild-v6-metadata-v2` |
| Observability | Native Workflow instance status/output and AI Search item status |

The instance owns two custom metadata fields: `published_at` and `kind`, matching
the supported search filters. Platform and monitored-source provenance stay in
PostgreSQL. Corpus blogs, forums, posts, videos, papers, and PDF files with a
readable original enter the index. Private Resources and images never enter it.
PostgreSQL is the canonical corpus; AI Search is a keyed, eventually consistent
secondary index. Web hydrates and authoritatively filters every returned Resource ID.

This runner removes the unused custom `source_id` and `resource_platform` fields from both search
instances. Updating the custom metadata schema triggers a full re-index;
complete the rebuild before judging its readiness.

## Runtime sync

Resource and translation Workflows enqueue a Resource ID after persistence.
The `resource-search-sync` Queue consumer deduplicates IDs within each batch,
loads their current corpus documents in one query, and calls `syncCorpusItem` per Resource.
Each Resource's messages are acknowledged or retried together; eligible
Resources upload to `resources/<resource-id>.md`, while ineligible or deleted
Resources remove that exact key through the native AI Search `key` filter.
Canonical resource readiness never depends on this derived index. There is no
R2 corpus mirror, database readiness row, generation lease, or app-side serving
cutover.

## Rebuild graph

One rebuild performs these durable operations:

1. configure the AI Search instance;
2. upload every currently eligible Resource in UUID order;
3. upload a start-time delta using the newest Resource or translation revision;
4. prune keyed items that no longer map to an eligible PostgreSQL row;
5. poll native AI Search status until queued/running are zero, terminal counts
   are zero, and completed/keyed item counts match the live PostgreSQL count;
6. return the counts and reconciliation summary as Workflow output.

AI Search owns indexing and item status. Workflow owns durable steps, retries,
status, errors, and output. A terminal `error`, `skipped`, or `outdated` item
fails the rebuild visibly; Core does not maintain a second repair state machine.

## Start a rebuild

Confirm the dedicated instance exists. Create it only in a fresh environment;
never replace the production instance.

```sh
pnpm -C workers/core-worker exec wrangler ai-search get newsence-corpus-v6

# Fresh environments only:
pnpm -C workers/core-worker exec wrangler ai-search create \
  newsence-corpus-v6 \
  --type builtin \
  --hybrid-search
```

Run the static gates and deploy the current Workflow version:

```sh
pnpm -C workers/core-worker run typecheck
pnpm -C workers/core-worker run lint
pnpm -C workers/core-worker run deploy
```

Do not run two rebuilds concurrently. Trigger the current source-controlled
runner ID:

```sh
pnpm -C workers/core-worker exec wrangler workflows trigger \
  newsence-search-index-rebuild \
  '{}' \
  --id search-index-rebuild-v6-metadata-v2
```

## Verify

Inspect the same Workflow instance:

```sh
pnpm -C workers/core-worker exec wrangler workflows instances describe \
  newsence-search-index-rebuild \
  search-index-rebuild-v6-metadata-v2
```

A completed instance has already returned a final observation with:

- canonical instance configuration;
- zero queued, running, outdated, error, and skipped items;
- `completed === indexedItems === expectedItems`;
- full upload, delta, and stale-prune summaries.

Each deployment creates a versioned Workflow graph, and an instance remains
pinned to the version it started with. After an incompatible graph change,
deploy first and use a new source-controlled runner ID. A separate binding,
Workflow resource, or entrypoint is unnecessary.

## Failure handling

If a rebuild fails:

1. inspect the failed native Workflow step and AI Search item status;
2. keep the serving instance and PostgreSQL schema intact;
3. fix the source document or Worker code that produced a terminal item;
4. restart the same runner only for a transient, source-compatible failure;
5. after a graph change, deploy and trigger a new runner ID;
6. require a completed Workflow output before considering the rebuild healthy.

Historical generation-3/generation-4, shadow-rollout, and one-shot repair
resources are not active bindings and must not be triggered. Retiring remote
history is a separate destructive operation requiring an explicit audit.
