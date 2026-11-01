# Corpus vectors operations

This runbook covers the public Resource index. PostgreSQL is the canonical
corpus; Vectorize is a keyed, eventually consistent secondary index. Web hydrates
and authoritatively filters every returned Resource ID.

## Active contract

| Role | Active resource |
| --- | --- |
| Binding (Core only) | `CORPUS_VECTORS → newsence-corpus-vectors-v1` (1024-d, cosine); Web asks through `searchCorpus` and `nearCorpusResources` |
| Embedding | `@cf/baai/bge-m3` through AI Gateway |
| Writes | `resource-search-sync` Queue → `consumeSearchSyncBatch` |
| Backfill Workflow | `newsence-corpus-vectors-backfill` (`CorpusVectorsBackfillWorkflow`) |
| Name search | `pg_trgm` in Web, not this index |

Corpus blogs, forums, posts, videos, papers, and PDF files with a readable
original enter the index. Private Resources and images never enter it.

## Vectors

Each Resource has a document vector `<id>:d` (title, source, and summaries; for an
untitled kind its text) and up to 32 chunk vectors `<id>:<n>` of about 400 tokens
with 40 tokens of overlap, each prefixed with the title. A short untitled text is
whole in its document vector and has no chunks.

| Metadata | Indexed | Use |
| --- | --- | --- |
| `kind` | string | kind filter |
| `published_at` | number (unix seconds) | date filter |
| `role` | string | `doc` for related Resources, `chunk` |
| `subject_id` | no | collapse carriers onto their subject |
| `chars` | no | length weight: one-line posts rank below articles |
| `chunks` | no | on `:d`, how many chunks to clear when the text shrinks |
| `text` | no | passage returned to search (≤ 1,500 chars) |

Metadata indexes must exist before vectors are written; a new one only covers
vectors written after it. Vectorize deletes 100 ids, reads 20, and upserts 500
vectors per call, and returns at most 50 matches with metadata.

Search embeds the query, takes 50 matches, keeps each Resource's best weighted
score and up to three passages, then collapses carriers. Related Resources query
`<id>:d` with `role = 'doc'`.

## Backfill

Run the static gates and deploy, then start a runner with a new ID:

```sh
pnpm exec cf workflows instances create newsence-corpus-vectors-backfill \
  --body '{"instance_id":"corpus-vectors-backfill-v2","params":{}}'

pnpm exec cf workflows instances get corpus-vectors-backfill-v2 \
  --workflow-name newsence-corpus-vectors-backfill

pnpm exec cf vectorize info newsence-corpus-vectors-v1
```

The backfill writes 50 Resources per step directly and sends any that changed
mid-step to the sync queue. Its output counts pages, written, and requeued
Resources. Changing the embedding model or the chunking means a new index
(`-v2`), a backfill into it, then switching both bindings.
