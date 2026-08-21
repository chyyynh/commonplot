# Corpus refactor worklog

Temporary implementation record. Delete this file after every round below is complete and verified.

## Why this exists

The current `corpus` surface mixes four responsibilities:

1. public Resource eligibility (`scope = 'corpus'`, enriched, content identity);
2. AI Search document projection and synchronization;
3. feed/related/public-knowledge ranking;
4. product-authorized Resource resolution and bounded reading.

Only 1-3 belong near Core. Authorization over saves, user files, collections, workspaces, documents, and Resource reads belongs to the app-owned Web Domain.

## Target boundary

### Core Worker

- Own resource acquisition, enrichment, canonical graph persistence requests, and AI Search synchronization.
- Expose one public-search RPC that returns ordered Resource IDs from AI Search.
- Keep AI Search item keys, metadata, serialization, upload, exact-key deletion, and a bounded rebuild Workflow.
- Do not understand product ownership, collection/workspace membership, private document reads, or Web projections.

### Web Domain

- Own all Resource/document/workspace authorization.
- Resolve Resource references and read bounded, revision-pinned Resource content directly through Prisma/Postgres.
- Hydrate AI Search candidate IDs into canonical summaries/cards and re-apply authoritative DB filters.
- Build related-resource seed text from canonical persisted fields before requesting vector candidates.

### Think and MCP

- Continue using the app-owned `KnowledgeService`.
- Keep public search distinct from authorized exact-reference reads.
- Preserve continuation, serialized-byte budgets, and stable error contracts.

## Invariants

- AI Search is a secondary, eventually consistent index; Postgres remains canonical.
- Private `image`/`file` Resources never enter public AI Search.
- Public search results are DB-authorized/hydrated before leaving Web.
- Resource content access remains stricter than metadata/container access.
- AI Search sync stays inside durable Resource/translation Workflow steps.
- Cross-worker RPC values remain structured-clone serializable.
- No extra R2 or direct Vectorize corpus is introduced; AI Search built-in storage remains service-owned.
- Unrelated working-tree changes are never staged by this refactor.

## Rounds

### Round 1 — Web owns Resource knowledge reads

- Move `resolveCorpusResources` and `readCorpusResource` behavior into Web `KnowledgeService`.
- Reuse app-owned access predicates and Prisma/Postgres schema.
- Remove Core `corpus-retrieval.ts` and the two RPC methods.
- Remove RPC-only reader envelopes/types when no longer needed.
- Verify Web/Core/Think types and authorization-focused tests.

### Round 2 — One public-search primitive

- Replace `searchResources`, `searchResourceRanks`, and `relatedResourceIds` with one ordered-ID RPC.
- Keep AI Search metadata filters and hybrid/vector mode in Core.
- Move canonical hydration, related seed construction, offset handling, and final DB filtering to Web.
- Remove fake/unused rank scores and duplicate Core SQL hydration/filtering.
- Verify feed search, related resources, Think knowledge search, and MCP search.

### Round 3 — Native AI Search operations

- Update Core's current Wrangler/types patch so the exact AI Search item `key` filter is available.
- Replace bare-ID item search plus manual matching with the native exact-key filter.
- Reduce rebuild to the durable operations that are externally meaningful: configure, upsert, prune, wait/inspect, and return Workflow output.
- Remove `search_index_states` generation/readiness state if no serving or operator consumer remains.
- Preserve deterministic step names, retryable boundaries, and native Workflow observability.

### Round 4 — Naming, contracts, and documentation

- Reserve `corpus` for the public canonical set; use explicit public-search/index names for code surfaces.
- Remove stale wrappers, types, comments, and imports.
- Update active docs/runbook for `blog/lesswrong` and the final Workflow contract.
- Run Core typecheck/lint, Web typecheck/tests relevant to changed contracts, and Think typecheck/tests.

### Final round

- Confirm every round has its own commit.
- Confirm only unrelated user changes remain unstaged.
- Delete this temporary file.
- Run final verification and commit the deletion/cleanup.

