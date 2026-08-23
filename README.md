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

Ingestion engine for [**newsence.app**](https://www.newsence.app). Pulls contents from RSS / Twitter/X / YouTube / Hacker News / web URLs / uploaded files, runs bilingual AI analysis on each, and stores searchable resources with resource-local entity annotations. Each enriched corpus resource is synchronized to Cloudflare AI Search for retrieval.

## Supported Platforms

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| Platform             | Type      | Schedule      | What it does                                                                |
| -------------------- | --------- | ------------- | --------------------------------------------------------------------------- |
| **RSS Feeds**        | Monitor   | Every 5 min   | Fetches feeds, deduplicates by URL, detects HN links                        |
| **Twitter/X**        | Monitor   | Every 6 hours | Tracks users via Kaito API — tweets, threads, longform posts, media         |
| **YouTube**          | Monitor   | Every 30 min  | Atom feed → video metadata, transcripts, chapters, AI highlights            |
| **Hacker News**      | Processor | Via RSS       | Detects HN links → fetches comments via Algolia → generates editorial notes |
| **Web**              | Scraper   | Saved URL     | Full content extraction (Readability + Cheerio), OG metadata                |
| **App Inputs**       | Ingestion | Real-time     | Service-binding RPC — saved URL/blob acquisition + enrichment; membership stays app-owned |

All providers output identity-free acquisition material. One resolver finalizes
the Resource identity, then an exhaustive kind handler feeds the shared AI and
graph-persistence tail.

## How it works

Each resource goes through an automated workflow with independent retries:

```
Content arrives (source monitor / saved URL / uploaded blob / resync)
  │
  ├─ 1. Acquire ─────────────── Fetch a URL draft, or load/extract an app-owned blob
  ├─ 2. Resolve ─────────────── Finalize kind/platform identity, paper metadata, and subject intent
  ├─ 3. AI Analysis ─────────── AI Gateway calls → bilingual title, summary, tags, keywords, entities
  ├─ 4. Host Images ─────────── Stream canonical remote images to Cloudflare Images
  ├─ 5. Finalize DB ─────────── Create or update a canonical URL resource; enrich an existing stored blob
  └─ 6. Follow-ups ──────────── For corpus results, attach/enqueue subjects, translation, and AI Search sync
```

URL, source, and derived-subject attempts carry immutable Workflow drafts and create no
Resource row until step 5 succeeds. App-owned uploads are the record-first exception because
their ownership, quota, and blob locator already exist. Each durable step retries independently.

## AI Pipeline

| Stage                   | Model             | What it does                                                                                      |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| **Analysis**          | AI Gateway text model | Resource → bilingual title, summary, tags, and keywords                                             |
| **Entity Extraction** | AI Gateway JSON model | Resource → named entities (person, organization, product, technology, event, location) with EN + zh-TW names |
| **Retrieval Index**   | Cloudflare AI Search  | Hybrid keyword and semantic retrieval over enriched corpus documents                              |

Translation/summary and classification/entities are separate structured calls so one schema failure does not force the whole resource into fallback.

### Entity Quality Policy

The core worker keeps entity storage deterministic and conservative. It normalizes obvious duplicates, gates known entity types, filters generic tokens and self-source aliases, and caps stored entities per resource.

It intentionally does not perform semantic alias merging in the database. Model families, company/product containment, and alias groups are presentation-layer concerns until they have a reviewed alias source. For example, `google`, `google deepmind`, and `gemini` can be related without being the same canonical database entity.

Entity extraction remains enabled even though the Collection Wiki product surface is retired. The derived annotations live only in `resources.entities` and are retained for future retrieval or presentation work; there is no normalized global entity graph or reverse index.

Add normalized entity tables only when a real product consumer needs cross-resource queries that the resource-local JSON cannot answer cleanly. Potential future additions such as reviewed aliases or extraction-run history should follow that consumer rather than precede it.

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

The one-click Deploy button above handles Worker + Workflows, but **Hyperdrive, the database, and secrets need manual setup**. Full walkthrough:

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

### 4. Secrets

AI analysis uses the Workers AI binding through AI Gateway, so no external LLM secret is required. Platform/API secrets are required by Wrangler config:

```bash
wrangler secret put KAITO_API_KEY            # Twitter monitoring
wrangler secret put YOUTUBE_API_KEY          # YouTube monitoring
wrangler secret put OPENALEX_API_KEY          # Paper metadata enrichment
```

### 5. Deploy

```bash
pnpm install
pnpm run deploy
```

Or run locally with `pnpm dev` (uses `wrangler dev --test-scheduled`, so you can curl `/__scheduled?cron=*/5+*+*+*+*` to trigger RSS manually).

## API surface

Core exposes no product HTTP API; its default fetch handler only returns 404. App URL imports call a Cloudflare service-binding RPC with a Workflow instance ID, URL, and admission intent; monitors and derived subjects enqueue the same draft target internally. Uploaded blobs and explicit resyncs use persisted resource IDs. URL acquisition is an internal stage of the canonical resource Workflow.

URL/platform acquisition and app-owned R2 PDF reads both materialize one canonical processing aggregate. Core selects any academic replacement content first, commits the aggregate through the app Domain transaction, and runs subject, translation, and AI Search follow-ups only for corpus results.

## Hosted MCP

The newsence app exposes an anonymous, read-only hosted
[MCP](https://modelcontextprotocol.io) endpoint at
`https://www.newsence.app/api/mcp`. It supports public corpus search and
bounded resource reads. The retired local CLI/MCP package is not part of this
Worker.

## Architecture

```
src/
├── index.ts              # Cloudflare WorkerEntrypoint class only
├── entities/             # resource-local entity normalization
├── shared/               # small cross-subsystem primitives
│   ├── resource.ts       # identity, identifiers, and canonical metadata contracts
│   ├── image-mapping.ts  # canonical Hosted Images field mapping
│   └── url.ts            # URL normalization and exact platform locators
├── ingest/               # ── resource ingestion pipeline (the open-source core) ──
│   ├── workflow.ts       # acquisition-to-persistence Workflow
│   ├── processing-jobs.ts # immutable draft and stored-target payloads
│   ├── stored-resource.ts # narrow record-first blob and resync projections
│   └── platforms/        # one file per source/stage
│       ├── rss.ts        # feed polling
│       ├── twitter.ts    # monitor + scraper + processor
│       ├── youtube.ts    # monitor + transcript/highlights
│       ├── hackernews.ts # HN processor
│       ├── paper.ts      # OpenAlex enrichment stage
│       └── pdf.ts        # PDF text extraction stage
├── ai-search.ts           # AI Search projection, sync, and rebuild Workflow
└── public-search.ts       # ordered public Resource ID retrieval
```

## Environment Variables & Bindings

Bindings (in `wrangler.jsonc`):

| Binding            | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `HYPERDRIVE`       | Hyperdrive connection to your Postgres       |
| `RESOURCE_PROCESSING_V2_WORKFLOW` | Fetch, parse, classify, and persist a canonical resource |
| `RESOURCE_TRANSLATION_V2_WORKFLOW` | Translate a persisted resource into zh-Hant |
| `SEARCH_INDEX_GENERATION_5_REBUILD_WORKFLOW` | Rebuild and verify the generation-5 canonical search index |
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

### Canonical AI Search v6

`AI_SEARCH` serves `newsence-corpus-v6`. Its four custom metadata fields are
`effective_at`, `source_id`, `kind`, and `resource_platform`; null
platforms use the reserved `none` sentinel. PostgreSQL remains canonical;
AI Search stores only keyed search documents and eventually consistent status.

The searchable identity pairs are `blog / none`, `blog / lesswrong`,
`forum / hackernews`, `post / twitter`, `video / youtube`, and `paper / none`.
Private image and file Resources never enter the public index.

Run the static gates, then start and inspect the generation-specific Workflow
with Wrangler:

```sh
pnpm exec wrangler workflows trigger \
  newsence-search-index-generation-5-rebuild \
  '{}' \
  --id search-index-rebuild-generation-5-native-v2

pnpm exec wrangler workflows instances describe \
  newsence-search-index-generation-5-rebuild \
  search-index-rebuild-generation-5-native-v2
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

Generation 5 and the canonical `blog`/`forum` database cutover are complete.
The one-shot migration lives in git history; current operations start from the
target schema and use the active rebuild/verification procedure above.

#### Historical generation evidence

`newsence-corpus-v5`, durable state `public-corpus`, generation
`3 / canonical-3-kind`, and `newsence-search-index-rebuild` belong to the
completed #245 rollout. Historical scripts and logs retain those exact names as
evidence. Generation 4 used `canonical-4-kind-platform` and
`newsence-search-index-canonical-v6-rebuild`. These historical Workflow
resources are not active bindings and must not be triggered or adopted for the
generation-5 contract.

### Paper enrichment

Exact DOI, arXiv, and OpenAlex identities resolve through the official OpenAlex
REST API. Provider failures preserve an existing compact academic snapshot.

## Adding an Ingest Adapter

Ingest adapters live in `ingest/platforms/*.ts` with the
discovery/scrape/process pieces they actually need. New saved URLs and monitored
items enter the Workflow as immutable drafts; only successful processing creates
or merges a canonical `resources` row and applies its save, container, source or
subject admission in the same app-Domain transaction. App-owned uploads remain
the explicit record-first exception and create `resources` plus `user_files`
before Core reads the stored blob. Every successful path crosses the single
`DOMAIN.persistResolvedResource` transaction boundary with either a draft
admission target or a revision-guarded existing-resource target.

Keep the axes separate: acquisition (generic web or a specialized adapter) is
not canonical `ResourcePlatform` (`youtube`, `twitter`, `hackernews`, `lesswrong`, or null),
`ResourceKind` (`blog`, `forum`, `post`, `video`, `paper`, `image`, `file`), blob
representation (MIME/filename/size/pages), or lifecycle origin (`source`,
`saved_url`, `upload`, `generated`). External URL PDF extraction happens from
the acquired response without an R2 write; uploaded PDF extraction reads the
app-owned blob. Neither representation is an additional identity value.

Web submits one monitor input and Core detects a feed URL, YouTube channel, or
X/Twitter account. `Source.monitorKind` stores only the operational `feed` or
`twitter` cron route. Feed entries acquire their canonical URL, where normal
resource detection selects LessWrong and YouTube adapters when applicable.

Minimum to add a new ingest source:

1. **Adapter file** (`ingest/platforms/foo.ts`) — discovery/scrape helpers and optional custom processor.
2. **Canonical adapter output** — normalize provider data into common creators,
   versioned kind metadata, exact identifiers, and an optional immediate subject.
3. **Identity contract** — add the exact locator and valid `(kind, platform)` pair.
4. **Monitor** (optional) — wire a cron only when discovery is not already a feed.

The new resource goes through the same Workflow pipeline as every other ingest
source. Resolver owns the final identity, the narrowed kind handler owns
provider behavior, and the shared graph sink owns persistence. Adding a
platform must not add a provider branch to common Workflow or Web rendering.

## License

MIT
