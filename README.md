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

| Input | Acquisition flow |
| --- | --- |
| **Web URL** | Fetch/redirect detection → HTML article and source metadata → Markdown; PDF responses enter the PDF parser |
| **Uploaded PDF** | Read owned R2 blob → Zotero text/figures and GROBID header in parallel → optional Crossref confirmation; unresolved documents remain private files |
| **Paper** | Exact URL or PDF identity → OpenAlex for web sources / Crossref for PDFs → canonical identifiers and bibliography; optional OpenAlex content PDF |
| **Twitter/X** | twitterapi.io → post or article Markdown, media and linked subject; monitoring uses cursor pagination every 6 hours |
| **YouTube** | Video metadata → channel avatar and transcript in parallel → chapters or AI highlights → canonical transaction also saves transcript data |
| **Hacker News** | Firebase story and ranked comments → Markdown discussion; an external article remains a separate subject |
| **LessWrong** | GraphQL post → native Markdown and source metadata |
| **RSS / Atom / JSON Feed** | Fetch → feed parser → normalized URL drafts → normal acquisition; every 5 minutes, with a 30-minute interval for YouTube feeds |

`platforms/resource-url.ts` resolves platform and paper identities for app lookup, feeds, linked subjects, acquisition, and persistence. It preserves the fetch URL separately from the normalized identity key; redirects and response MIME still select the final adapter. Each adapter owns its source parsing and Resource output.
Only the output contract and small source-hint rules are shared; there is no generic materializer.
The Workflow passes those outputs to analysis, image hosting, and persistence.
`admission.ts` owns processing inputs and monitor dispatch; adapters produce its source hints directly. `acquisition.ts` owns URL/upload/resync routing and the acquired-content contract. `workflow.ts` composes durable stages, while `index.ts` directly re-exports its class for Cloudflare.

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
  ├─ 3. Prepare ─────────────── Detect language locally; generate only a missing summary, alongside image hosting
  ├─ 4. Finalize DB ─────────── Write canonical/private representations; publish eligible public PDF crops
  ├─ 5. Ready ──────────────── Apply user save and report the readable resource
  └─ 6. Follow-ups ──────────── Classify tags/keywords → search indexing; translation, references and subjects run independently
```

URL, source, and derived-subject attempts carry immutable Workflow drafts and create no
Resource row until step 4 succeeds. App-owned uploads are the record-first exception because
their ownership, quota, and blob locator already exist. Source monitors filter completed
canonical Resources in PostgreSQL before enqueueing; only in-flight and failed attempts use
short native Workflow retention. Each durable step retries independently.

### PDF processing and recovery

Core uses the pinned Zotero document-worker for structured text and source-region rendering. Uploaded and fetched PDFs share `parseStoredPdfRepresentation`; Web only projects persisted renditions and authorizes their media.

#### Quality and retries

`structuredPdfVisualPlan` selects semantic figures/tables and conservative caption-bounded regions. It retains author text while excluding repeated first-page affiliation blocks misclassified as tables. The 64-crop budget and unavailable/ambiguous geometry produce explicit missing-region outcomes. Inferred regions remain marked `caption-region-inferred`; usable text does not imply proven visual completeness. No inferred region automatically authorizes a paid OCR provider.

Each source has:

- `<pdfStorageKey>.structured-document.json`: structured text, admitted by input SHA-256 and the parser artifact revision.
- `<pdfStorageKey>.structured-crops/<inputSha256>/manifest.json`: planned/ready crop IDs, retryable or permanent failures, and the completed text/visual quality summary. Quality is null until every planned crop is stored.
- Immutable `<cropId>.png` images. IDs include the pinned build, schema/processor version, crop recipe, page, and rectangle.

The renderer receives one PDF per batch of at most eight regions. It streams bounded PNG rows; Core stores each result independently. An incomplete batch persists its manifest and fails the acquisition checkpoint. Workflow retries retain the structured document and successful PNGs and render only missing crops. Permanent input failures stop retries; transport, capacity, and server errors remain retryable. Container queue wait expiry rejects only that waiting request; the active processing watchdog starts after admission.

When changing the document-worker build or crop algorithm, update the explicit artifact/recipe versions in `zotero-sdt.ts` alongside the pinned Docker build as applicable. Do not overwrite old crop objects: stored content may still reference their immutable URLs. Existing private crop URLs without a digest remain readable.

#### Source ownership

Uploaded PDF content and translations stay on its private raw Resource. If paper identification also produces a corpus Resource, Core removes private crop image references from the shared body. The owner's reader and authorized Knowledge reads project the attached raw rendition; anonymous/public reads use corpus content. Deleting the upload removes that raw rendition and its crop family, so owner reads fall back to the independent corpus version. Private media authorization is unchanged.

Public URL acquisition writes a separate `public-pdf/<sourceSha256>/<inputSha256>/` family. Matching bytes in a private upload never establish public provenance. Only after canonical persistence does Core validate the source and complete crop manifest and write `publication.json`. Public crop delivery requires that publication, an enriched corpus Resource, and the exact crop URL in its current original content. Raw public acquisition artifacts have no public download route. Public crop storage is independent of user upload deletion.

Existing corpus bodies with private image references are cleaned when explicitly reprocessed, including references in preserved human translations. Human text remains intact; obsolete alignment is cleared. This is an ingestion repair, not a mutation performed by reads.

#### Operator verification

Run `pnpm lint`, `pnpm run typecheck`, and `pnpm test` from this workspace. Six checks cover resource processing, platform acquisition, translation, PDF normalization, real workerd/R2 storage, and container HTTP/queue behavior. Use `pnpm check:pdf` for the three PDF checks. Runtime checks use isolated local bindings; container HTTP checks bind localhost. Web checks cover user authorization, delivery, and deletion. Temporary repair or investigation scripts belong outside the repository.

Deploy the Web media/reading changes and the Core Worker **with its updated Zotero container image** before admitting new processing. A Worker-only deployment with `--containers-rollout=none` cannot activate the new batch endpoint.

After deployment, reprocess an uploaded PDF using the existing service RPC `enqueueResourceProcessing({ resourceId: <raw-file-resource-id>, retry: true })`; do not pass its canonical paper ID. Use `resyncResource` for a resource with an external URL. Inspect Workflow status, the crop manifest and its quality summary, canonical/private translations, and owner/non-owner reads. A completed canonical row alone does not prove all follow-ups succeeded. No production backfill is implicit in a code deployment.

The Cocoa regression was checked against the user-supplied 23-page PDF: the new plan has 10 figures and 4 genuine tables; 19 affiliation crops are excluded. All 14 regions rendered with the pinned Zotero runtime, and all five recovered figures were visually inspected. The full copyrighted PDF is not committed as a fixture.

## AI Pipeline

| Stage                   | Model             | What it does                                                                                      |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| **Summary**           | AI Gateway structured output | Generate only when the source has no summary; language is detected locally                        |
| **Classification**    | AI Gateway structured output | Tags and keywords after the resource is readable                                                  |
| **Translation**       | AI Gateway text models      | Admitted persisted Resources → zh-Hant title, summary, and content                                |
| **Retrieval Index**   | Cloudflare AI Search  | Hybrid keyword and semantic retrieval over enriched corpus documents                              |

Summary generation and background classification are separate structured calls. Translation runs in its own Workflow, so localization failure cannot invalidate an already persisted canonical Resource.

Core preserves a nonblank source summary or abstract. When it is missing, the existing analysis call also generates a summary in the original language; a body excerpt is not a source summary. Metadata localization translates the persisted summary in full and never creates one from the body. Existing records without a summary receive title-only metadata translation until reprocessed. Run `pnpm check:resource-identity` and `pnpm check:platform-acquisition` to check source metadata precedence and platform summaries.

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

The canonical app-owned schema lives in `web-tanstack/prisma/schema.prisma`, with DB-only constraints and indexes in `web-tanstack/prisma/manual-indexes.sql`. Core uses Drizzle's parameterized SQL over Hyperdrive without maintaining a second table schema. Run `pnpm check:resource-identity` after Core identity-domain changes. Schema changes also require Web migration replay and `pnpm db:drift-check` against disposable databases.

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

Core exposes no product HTTP API; its default fetch handler only returns 404. App imports first call `resolveResourceUrls` once per batch to match normalized URLs and exact identifiers against existing corpus resources. Web rechecks and saves existing IDs; aliases of a missing URL share one draft. Draft dispatch uses a Cloudflare service-binding RPC with a Workflow instance ID, original fetch URL, and user-owned `saveTarget`; monitors and derived subjects enqueue the same draft target internally without one. Uploaded blobs and explicit resyncs use persisted resource IDs. URL acquisition is an internal stage of the canonical resource Workflow.

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
│   ├── admission.ts      # processing input schemas and deduplicated source dispatch
│   ├── analysis.ts       # AI classification and resource-local entity normalization
│   ├── acquisition.ts    # URL/upload/resync acquisition and content contract
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
