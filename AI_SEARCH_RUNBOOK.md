# AI Search operations

This runbook covers the active public Resource index. Historical rollout and
one-shot repair procedures remain in Git history, not in the current operator
surface.

## Active contract

| Role | Active resource |
| --- | --- |
| Serving binding | `AI_SEARCH → newsence-corpus-v7` |
| Rebuild binding | `SEARCH_INDEX_REBUILD_WORKFLOW` |
| Physical Workflow | `newsence-search-index-rebuild` |
| Entrypoint | `SearchIndexRebuildWorkflow` |
| Current runner | `search-index-rebuild-v7-v2` |
| Observability | Native Workflow instance status/output and AI Search item status |

The instance embeds with `@cf/baai/bge-m3` and owns three custom metadata fields:
`published_at` and `kind` for the search filters, and `subject_id` on carriers
(HN threads, reposts) so results can collapse onto the Resource they discuss.
Public search runs hybrid retrieval; related Resources query the same index
vector-only with a Resource's titles and summary. Platform and monitored-source provenance stay in
PostgreSQL. Corpus blogs, forums, posts, videos, papers, and PDF files with a
readable original enter the index. Private Resources and images never enter it.
PostgreSQL is the canonical corpus; AI Search is a keyed, eventually consistent
secondary index. Web hydrates and authoritatively filters every returned Resource ID.

Updating the embedding model needs a new instance; updating the custom metadata
schema triggers a full re-index. Complete the rebuild before judging readiness.

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
2. prune keyed items that no longer map to an eligible PostgreSQL row, noting
   which Resources the index still holds;
3. enqueue, in UUID order, every eligible Resource the index lacks (all of them
   for a fresh instance) plus, with `since`, every one changed after it, on the
   search sync queue, whose consumer uploads the current snapshot and absorbs
   races with live writes;
4. poll native AI Search status until queued/running are zero, terminal counts
   are zero, and completed/keyed item counts match the live PostgreSQL count;
5. return the counts and reconciliation summary as Workflow output.

AI Search owns indexing and item status. Workflow owns durable steps, retries,
status, errors, and output. A terminal `error`, `skipped`, or `outdated` item
fails the rebuild visibly; Core does not maintain a second repair state machine.

## Start a rebuild

Confirm the dedicated instance exists. Create it only in a fresh environment;
never replace the production instance.

```sh
pnpm -C workers/core-worker exec cf ai-search get newsence-corpus-v7 --name default

# Fresh environments only:
pnpm -C workers/core-worker exec cf ai-search create default newsence-corpus-v7 \
  --index-method-keyword true \
  --index-method-vector true
```

Run the static gates and deploy the current Workflow version:

```sh
pnpm -C workers/core-worker run typecheck
pnpm -C workers/core-worker run lint
pnpm -C workers/core-worker exec cf deploy
```

Do not run two rebuilds concurrently. Trigger the current source-controlled
runner ID:

```sh
pnpm -C workers/core-worker exec cf workflows instances create newsence-search-index-rebuild \
  --params '{}' \
  --instance-id search-index-rebuild-v7-v2
```

A rerun on a loaded index only fills its gaps. To also refresh Resources whose
document changed while writes went elsewhere, pass `since` (an ISO instant); a
document-format change reloads everything with `"since":"1970-01-01T00:00:00Z"`:

```sh
pnpm -C workers/core-worker exec cf workflows instances create newsence-search-index-rebuild \
  --params '{"since":"2026-09-30T09:00:00Z"}' \
  --instance-id search-index-catchup-v7-v1
```

## Verify

Inspect the same Workflow instance:

```sh
pnpm -C workers/core-worker exec cf workflows instances get search-index-rebuild-v7-v2 \
  --workflow-name newsence-search-index-rebuild
```

A completed instance has already returned a final observation with:

- canonical instance configuration;
- zero queued, running, outdated, error, and skipped items;
- `completed === indexedItems === expectedItems`;
- enqueue and stale-prune summaries.

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

## Recommendation vectors

`RESOURCE_VECTORS → newsence-resources-v1` (Vectorize, 1024 dimensions, cosine)
holds one `@cf/baai/bge-m3` vector per searchable corpus Resource, keyed by
Resource ID. The text is the English title and summary (a post's opening text),
falling back to the original where no English exists; non-English originals get
a machine English title and summary from the translation Workflow. Metadata is
`kind`, `published_at` (Unix seconds) and, on carriers, `subject_id`. The
`kind` and `published_at` metadata indexes were created before any vector was
written; a new metadata index needs every vector upserted again.

The `resource-search-sync` consumer writes vectors for the whole batch with one
embedding call before it touches AI Search. Messages with `only: "vectors"`
leave the AI Search item alone.

Backfill after deploying, translations first. Wait for `translate` to complete
(about a minute per 25 Resources) before starting `embed`. Pass the payload in
`--body`: `--params` sends it as a JSON string, so the Workflow sees no `phase`.

```sh
pnpm -C workers/core-worker exec cf workflows instances create newsence-resource-vector-backfill \
  --body '{"instance_id":"resource-vector-backfill-translate-v2","params":{"phase":"translate"}}'
pnpm -C workers/core-worker exec cf workflows instances create newsence-resource-vector-backfill \
  --body '{"instance_id":"resource-vector-backfill-embed-v1","params":{"phase":"embed"}}'
pnpm -C workers/core-worker exec cf vectorize info newsence-resources-v1
```
