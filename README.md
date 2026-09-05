<div align="center">

# newsence

**A content discovery engine that helps LLMs understand your world**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![npm: newsence](https://img.shields.io/npm/v/newsence?label=npm%3A%20newsence&color=cb3837&logo=npm)](https://www.npmjs.com/package/newsence)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?logo=anthropic&logoColor=white)](https://www.newsence.app/api/mcp)
[![Website](https://img.shields.io/badge/newsence.app-live-00c853)](https://www.newsence.app)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/newsence)

[English](README.md) | [繁體中文](README.zh-TW.md)

</div>

---

## What is newsence?

Ingestion engine for [**newsence.app**](https://www.newsence.app). Pulls content from RSS / Twitter/X / YouTube / Hacker News / web URLs / uploaded files, runs structured AI analysis and zh-Hant localization, and stores searchable resources with resource-local entity annotations. Each enriched corpus resource is synchronized to Cloudflare AI Search for retrieval.

## Supported Platforms

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| Platform             | Type      | Schedule      | What it does                                                                |
| -------------------- | --------- | ------------- | --------------------------------------------------------------------------- |
| **RSS Feeds**        | Monitor   | Every 5 min   | Fetches feeds, deduplicates by URL, detects HN links                        |
| **Twitter/X**        | Monitor   | Every 6 hours | Tracks users via Kaito API — posts, longform posts, and media               |
| **YouTube**          | Monitor   | Every 30 min  | Atom feed → video metadata, transcripts, chapters, AI highlights            |
| **Hacker News**      | Processor | Via RSS       | Detects HN links → fetches comments via Algolia → generates editorial notes |
| **Web**              | Scraper   | Saved URL     | Article extraction, redirect/platform detection, PDF detection, OG metadata |
| **App Inputs**       | Ingestion | Real-time     | Service-binding RPC — saved URL/blob acquisition + enrichment; membership stays app-owned |

One URL detector selects the owning platform adapter. Each platform/kind adapter owns its source parsing, identity, and Resource output.
Only the output contract and small source-hint rules are shared; there is no generic materializer.
The Workflow passes those outputs to analysis, image hosting, and persistence.

Web and PDF adapters produce readable Resources directly; paper resolution adds bibliographic identity to that Resource.
For platform changes, start in its adapter and keep the dispatcher limited to routing. A new platform also needs its
identity contract in `src/shared/resource.ts` and matching database constraints. Debug the acquisition step's Resource
output before checking analysis, canonical persistence, and the separate app-save/follow-up steps.

## How it works

Each resource goes through an automated workflow with independent retries:

```
Content arrives (source monitor / saved URL / uploaded blob / resync)
  │
  ├─ 1. Acquire ─────────────── Fetch a URL draft, or load/extract an app-owned blob
  ├─ 2. Resolve ─────────────── Finalize kind/platform identity, paper metadata, and subject intent
  ├─ 3. AI Analysis ─────────── One call → tags, keywords, original language; fill a missing summary
  ├─ 4. Host Images ─────────── Stream canonical remote images to Cloudflare Images
  ├─ 5. Finalize DB ─────────── Create or update a canonical URL resource; enrich an existing stored blob
  └─ 6. Follow-ups ──────────── Apply user save; enqueue translation, subject, and corpus-search jobs
```

URL, source, and derived-subject attempts carry immutable Workflow drafts and create no
Resource row until step 5 succeeds. App-owned uploads are the record-first exception because
their ownership, quota, and blob locator already exist. Source monitors filter completed
canonical Resources in PostgreSQL before enqueueing; only in-flight and failed attempts use
short native Workflow retention. Each durable step retries independently.

## AI Pipeline

| Stage                   | Model             | What it does                                                                                      |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| **Analysis**          | AI Gateway structured output | Resource → tags, keywords, and canonical original language                                       |
| **Translation**       | AI Gateway text models      | Admitted persisted Resources → zh-Hant title, summary, and content                                |
| **Retrieval Index**   | Cloudflare AI Search  | Hybrid keyword and semantic retrieval over enriched corpus documents                              |

Resource analysis is one structured call. Translation runs later in its own Workflow, so localization failure cannot invalidate an already persisted canonical Resource.

Core preserves a nonblank source summary or abstract. When it is missing, the existing analysis call also generates a summary in the original language; a body excerpt is not a source summary. Metadata localization translates the persisted summary in full and never creates one from the body. Existing records without a summary receive title-only metadata translation until reprocessed. Run `pnpm check:resource-identity` and `pnpm check:platform-acquisition` to check original-summary selection.

## Stack

| Layer         | Technology                                        |
| ------------- | ------------------------------------------------- |
| Runtime       | Cloudflare Workers (V8 isolates)                  |
| Orchestration | Cloudflare Workflows                              |
| Database      | PostgreSQL (via Cloudflare Hyperdrive)            |
| LLM           | Cloudflare AI Gateway                             |
| Search        | Cloudflare AI Search                              |
| Twitter Data  | Kaito API (third-party)                           |

## Self-Hosting

The one-click Deploy button above handles Worker + Workflows, but **Queues, Hyperdrive, the database, and secrets need manual setup**. Full walkthrough:

### 1. Database

You need a PostgreSQL instance. Production currently runs on PlanetScale Postgres through Cloudflare Hyperdrive.

The canonical app-owned schema lives in `web-tanstack/prisma/schema.prisma`, with DB-only constraints and indexes in `web-tanstack/prisma/manual-indexes.sql`. Core uses Drizzle's parameterized SQL over Hyperdrive without maintaining a second table schema. Run `pnpm check:db-contract` after schema or resource/source domain changes.

### 2. Hyperdrive binding

Create a Hyperdrive that points to your database:

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

Copy the returned ID into `wrangler.jsonc` under the `hyperdrive[].id` field.

### 3. Cloudflare Workflows

Workflows are provisioned automatically on first deploy via the `workflows` bindings in `wrangler.jsonc`.

The `resource-search-sync` Queue is provisioned from `wrangler.jsonc`. Resource
and translation Workflows durably enqueue a Resource ID after PostgreSQL commits;
the Queue consumer updates the derived AI Search document with native per-message
acknowledgement and bounded retries. Workflow failures remain visible through
Cloudflare's native Workflow status and Workers Logs.

### 4. Secrets

AI analysis uses the Workers AI binding through AI Gateway, so no external LLM secret is required. Platform/API secrets are required by Wrangler config:

```bash
wrangler secret put KAITO_API_KEY            # Twitter monitoring
wrangler secret put YOUTUBE_API_KEY          # YouTube monitoring
wrangler secret put OPENALEX_API_KEY          # Paper metadata enrichment
wrangler secret put LLAMA_CLOUD_API_KEY       # Paid PDF fallback
wrangler secret put LLAMA_CLOUD_PROJECT_ID    # Deployment-specific Llama Cloud project
```

Zotero Structured Document Text is the primary PDF parser. A private upload is
streamed to a sleeping `basic` Cloudflare Container once; Core derives its
Markdown, bibliography, citation links, and PDF source coordinates from that
single document and stores the bounded SDT JSON beside the original R2 object,
guarded by the source SHA-256. GROBID handles only the academic header/identifier
gate, and Crossref enriches the resulting bibliography.

LlamaParse remains a local-first OCR fallback. Web owns the product kill switch
and Autumn eligibility, then attaches a per-document page grant to authenticated
URL and newly uploaded PDF workflows. Core executes only granted fallbacks when
the SDT extraction is empty, degraded, or dominated by image-only pages, and
independently enforces the 100-page and 25 MiB safety caps. Private uploads use a
temporary Llama Cloud file that Core deletes when the fallback finishes or
aborts; ambiguous provider mutations fail loudly with a stable external ID for
operator cleanup. OpenAlex key-bearing content URLs remain local-only. The
provider adapter is locked to the US API, the `cost_effective` tier, and a dated
parser version. Enable Web grants only after an authorized development smoke
records the observed credits.

### 5. Deploy

```bash
pnpm install
pnpm run deploy
```

Or run locally with `pnpm dev` (uses `wrangler dev --test-scheduled`, so you can curl `/__scheduled?cron=*/5+*+*+*+*` to trigger RSS manually).

## API surface

Core exposes no product HTTP API; its default fetch handler only returns 404. App URL imports call a Cloudflare service-binding RPC with a Workflow instance ID, URL, and user-owned `saveTarget`; monitors and derived subjects enqueue the same draft target internally without one. Uploaded blobs and explicit resyncs use persisted resource IDs. URL acquisition is an internal stage of the canonical resource Workflow.

URL/platform acquisition and app-owned R2 PDF reads each produce one canonical processing aggregate. Core selects any academic replacement content first, commits canonical Resource state through Drizzle/Hyperdrive, and then runs a separate durable Web step only when user save/container/file ownership must be updated.

## Hosted MCP

The newsence app exposes an anonymous, read-only hosted
[MCP](https://modelcontextprotocol.io) endpoint at
`https://www.newsence.app/api/mcp`. It supports public corpus search and
bounded resource reads. The retired local CLI/MCP package is not part of this
Worker.

## Architecture

```
src/
├── index.ts              # service RPC, cron, and Workflow-error Queue entrypoints
├── shared/               # small cross-subsystem primitives
│   ├── resource.ts       # identity, identifiers, and canonical metadata contracts
│   ├── image-mapping.ts  # canonical Hosted Images field mapping
│   └── db.ts             # Drizzle over Hyperdrive
├── ingest/               # ── resource ingestion pipeline (the open-source core) ──
│   ├── workflow.ts       # durable resource processing and follow-up orchestration
│   ├── analysis.ts       # AI classification and resource-local entity normalization
│   ├── acquisition.ts    # one platform detection pass and adapter dispatch
│   ├── resource-persistence.ts # canonical Resource transaction
│   ├── source-monitor-state.ts # monitor watermarks and failure state
│   ├── translation-workflow.ts # durable translation and canonical writeback
│   └── platforms/        # one file per source/stage
│       ├── rss.ts        # feed polling
│       ├── twitter.ts    # source monitor
│       ├── twitter-acquisition.ts # tweet acquisition
│       ├── youtube.ts             # source resolution, acquisition, transcript/highlights
│       ├── hackernews.ts # HN processor
│       ├── paper.ts      # OpenAlex enrichment stage
│       └── pdf.ts        # app-owned and external PDF acquisition/extraction
├── operations/           # operator-triggered durable jobs
│   └── search-index-rebuild.ts # full AI Search rebuild
└── search-index.ts        # runtime AI Search projection, sync, and ordered retrieval
```

## Environment Variables & Bindings

Bindings (in `wrangler.jsonc`):

| Binding            | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `HYPERDRIVE`       | Hyperdrive connection to your Postgres       |
| `RESOURCE_PROCESSING_V2_WORKFLOW` | Fetch, parse, classify, and persist a canonical resource |
| `RESOURCE_TRANSLATION_V2_WORKFLOW` | Translate a persisted resource into zh-Hant |
| `SEARCH_INDEX_REBUILD_WORKFLOW` | Rebuild and verify the canonical search index |
| `RESOURCE_SEARCH_SYNC_QUEUE` | Durable AI Search sync after canonical PostgreSQL writes |
| `R2`               | App-owned uploaded PDF reads              |
| `IMAGES`           | Stream remote resource images to Cloudflare Images |
| `AI`               | Workers AI binding for AI Gateway text calls |
| `AI_SEARCH`        | `newsence-corpus-v6` canonical public corpus |

Secrets (via `wrangler secret put`):

| Variable                       | Required | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `KAITO_API_KEY`                | Yes      | Enables Twitter monitoring               |
| `YOUTUBE_API_KEY`              | Yes      | Enables YouTube channel monitoring       |
| `OPENALEX_API_KEY`             | Yes      | Enables exact paper metadata enrichment  |
| `LLAMA_CLOUD_API_KEY`          | Yes      | LlamaParse API key for this deployment   |
| `LLAMA_CLOUD_PROJECT_ID`       | Yes      | Isolated Llama Cloud project for this deployment |

### Canonical AI Search v6

`AI_SEARCH` serves `newsence-corpus-v6`. Its four custom metadata fields are
`published_at`, `source_id`, `kind`, and `resource_platform`; null
platforms use the reserved `none` sentinel. PostgreSQL remains canonical;
AI Search stores only keyed search documents and eventually consistent status.

The searchable identity pairs are `blog / none`, `blog / lesswrong`,
`forum / hackernews`, `post / twitter`, `video / youtube`, and `paper / none`.
Private image and file Resources never enter the public index.

Run the static gates, then start and inspect the rebuild Workflow with Wrangler.
The runner ID carries the serving-index version:

```sh
pnpm exec wrangler workflows trigger \
  newsence-search-index-rebuild \
  '{}' \
  --id search-index-rebuild-v6-publication-time-v1

pnpm exec wrangler workflows instances describe \
  newsence-search-index-rebuild \
  search-index-rebuild-v6-publication-time-v1
```

Wrangler's native instance description is the operator view of Workflow status,
steps, retries, errors, and final output. The rebuild configures AI Search,
uploads the full corpus and a start-time delta, prunes stale keyed items, then
waits until native item status and the live PostgreSQL count converge. There is
no duplicate database readiness row or custom item-repair state machine.

Each deployment creates a versioned Workflow graph and every instance remains
pinned to its `version_id`. Use a new source-controlled runner ID after an
incompatible graph change; do not add another binding or entrypoint. See
`AI_SEARCH_V6_RUNBOOK.md` for the active procedure.

### Paper enrichment

Exact DOI, arXiv, and OpenAlex identities resolve through the official OpenAlex
REST API. Provider failures preserve an existing compact academic snapshot.

## Adding an Ingest Adapter

Ingest adapters live in `ingest/platforms/*.ts` with the
discovery/scrape/process pieces they actually need. New saved URLs and monitored
items enter the Workflow as immutable drafts; only successful processing creates
or merges a canonical `resources` row. Core owns canonical source and subject
relations in the same Drizzle transaction; Web applies an optional user-owned
save/container/file target in the next durable step. App-owned uploads remain
the explicit record-first exception and create `resources` plus `user_files`
before Core reads the stored blob.

Keep the axes separate: acquisition (generic web or a specialized adapter) is
not canonical `ResourcePlatform` (`youtube`, `twitter`, `hackernews`, `lesswrong`, or null),
`ResourceKind` (`blog`, `forum`, `post`, `video`, `paper`, `image`, `file`), blob
representation (MIME/filename/size/pages), or lifecycle origin (`source`,
`saved_url`, `upload`, `generated`). External URL PDF extraction happens from
the acquired response without an R2 write; uploaded PDF extraction reads the
app-owned blob. Neither representation is an additional identity value.

Curated sources store only their operational `feed` or `twitter` cron route in
`Source.monitorKind`. Feed entries acquire their canonical URL, where normal
resource detection selects LessWrong and YouTube adapters when applicable.

Minimum to add a new ingest source:

1. **Adapter file** (`ingest/platforms/foo.ts`) — discovery/scrape helpers and optional custom processor.
2. **Canonical adapter output** — normalize provider data into common creators,
   versioned kind metadata, exact identifiers, and an optional immediate subject.
3. **Identity contract** — add the exact locator and valid `(kind, platform)` pair.
4. **Monitor** (optional) — wire a cron only when discovery is not already a feed.

The new resource goes through the same Workflow pipeline as every other ingest
source. Resolver owns the final identity, the narrowed kind handler owns
provider behavior, and Core's canonical transaction owns persistence. Adding a
platform must not add a provider branch to common Workflow or Web rendering.

## License

MIT
