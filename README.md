<div align="center">

# commonplot

**A content discovery engine that helps LLMs understand your world**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![npm: newsence](https://img.shields.io/npm/v/newsence?label=npm%3A%20newsence&color=cb3837&logo=npm)](https://www.npmjs.com/package/newsence)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?logo=anthropic&logoColor=white)](https://www.commonplot.co/api/mcp)
[![Website](https://img.shields.io/badge/commonplot.co-live-00c853)](https://www.commonplot.co)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/commonplot)

[English](README.md) | [繁體中文](README.zh-TW.md)

</div>

---

## What is commonplot?

Ingestion engine for [**commonplot.co**](https://www.commonplot.co). Pulls content from RSS / Twitter/X / YouTube / Hacker News / web URLs / uploaded files, runs structured AI analysis and zh-Hant localization, and stores searchable resources with resource-local entity annotations. Each enriched corpus resource is embedded into Cloudflare Vectorize for retrieval.

## Supported Platforms

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| Input                      | Acquisition flow                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web URL**                | Fetch/redirect detection → HTML article and source metadata → Markdown; PDF responses enter the PDF parser                                                                                                                                                    |
| **Uploaded PDF**           | Read owned R2 blob → Zotero text/figures and first-page identifiers → OpenAlex, accepted only when its title appears on the first page; a recognized paper is published with the upload as its full text and PDF; an unidentified upload stays a private file |
| **Paper**                  | Exact URL or PDF identity → OpenAlex for web sources / Crossref for PDFs → canonical identifiers and bibliography; OpenAlex content or licensed OA PDF                                                                                                        |
| **Twitter/X**              | twitterapi.io → post or article Markdown, media and linked subject; monitoring uses cursor pagination every 6 hours                                                                                                                                           |
| **YouTube**                | Video metadata → channel avatar and transcript in parallel → canonical transaction saves transcript and native chapters → optional AI highlights after publication, guarded by the acquisition revision                                                       |
| **Hacker News**            | Firebase story and ranked comments → Markdown discussion; an external article remains a separate subject                                                                                                                                                      |
| **LessWrong**              | GraphQL post → native Markdown and source metadata                                                                                                                                                                                                            |
| **RSS / Atom / JSON Feed** | Fetch → feed parser → normalized URL drafts → normal acquisition; each monitor's next check follows how often it published                                                                                                                                    |

`platforms/resource-url.ts` resolves platform and paper identities for app lookup, feeds, linked subjects, acquisition, and persistence. It preserves the fetch URL separately from the normalized identity key; redirects and response MIME still select the final adapter. Each adapter owns its source parsing and Resource output.
Only the output contract and small source-hint rules are shared; there is no generic materializer.
The Workflow passes those outputs to analysis, image hosting, and persistence.
`src/` is layered so each file imports only lower layers: `contracts/` (schemas and the acquired-content contract) → `services/` (external systems) → `adapters/` (provider acquisition, no database) and `store/` (all canonical SQL) → `monitors/` → `workflows/` and `search/`. `adapters/acquire.ts` routes a resolved URL or upload to one adapter; `workflows/processing.ts` reads the stored side of a resync or upload, then composes the durable stages, and `index.ts` re-exports its class for Cloudflare.

Web and PDF adapters produce readable Resources directly; paper resolution adds bibliographic identity to that Resource.
For platform changes, start in its adapter and keep the dispatcher limited to routing. A new platform also needs its
identity contract in `src/contracts/resource.ts` and matching database constraints. Debug the acquisition step's Resource
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
their ownership, quota, and blob locator already exist. Source monitors reuse canonical
Resources with a readable original and attach missing source provenance directly, without
repeating acquisition or AI work. Incomplete originals still enter the Workflow. Only
in-flight and failed attempts use short native Workflow retention. Each durable step retries independently.

YouTube language is normalized once into `resources.original_lang`; the transcript table stores only timed text, chapters and highlights. Apply `20260923100000_drop_unused_youtube_language` after deploying Core that no longer writes the duplicate column and draining older Workflow versions. This migration does not change resource languages or transcript content.

### PDF processing and recovery

Core uses the pinned Zotero document-worker for structured text and source-region rendering. Uploaded and fetched PDFs share `parseStoredPdfRepresentation`; Web only projects persisted content and authorizes its media.

Printed bibliography entries retain their full text in both Markdown footnotes and `resource_references`. Only the outgoing Crossref search query is capped at 600 characters; candidate matching and stale-result checks use the complete entry. Apply Web migration `20260923090000_preserve_full_reference_text` before deploying this Core change. Existing truncated entries and footnotes need normal reacquisition; the migration preserves existing rows without inventing missing text.

DOI suffixes are opaque identifiers. Core decodes resolver URL paths once and encodes canonical links, preserving reserved characters such as `#` and `?`. Sentence punctuation is removed only when extracting a DOI from prose, never from an explicit provider identifier.

OpenAlex preserves complete titles, author names, and venue names. Crossref reference lookups cap only outgoing citation queries at 600 characters. Provider checkpoints use streams; bounded provider responses still enforce the acquisition memory limits.

Known DOIs use Crossref's `/works/{doi}` endpoint with an encoded identifier; they never enter the comma-delimited filter grammar. A missing work returns no enrichment. Candidate/reference searches retain field projection and a 256 KiB response limit. Single-work responses do not support projection, so they allow up to 8 MiB; only normalized metadata enters the streamed Workflow checkpoint.

OpenAlex responses are bounded to 8 MiB before parsing. All paper metadata checkpoints use streams so complete normalized metadata can exceed the 1 MiB non-stream limit without discarding enrichment or repeating provider requests.

When the input has no parsed PDF, acquisition tries OpenAlex's cached PDF, then the selected licensed open-access PDF, then the original URL (or retains already acquired HTML). Each alternate source has its own download checkpoint and uses the shared SDT/crop pipeline. A public PDF equal to the original URL is left to normal URL acquisition rather than downloaded twice. Alternate PDFs use local parsing only; paid OCR remains tied to the original admitted source. API keys are added only to validated OpenAlex content requests and are never persisted in source URLs or sent to external PDF hosts.

#### Quality and retries

`structuredPdfVisualPlan` selects semantic figures/tables and conservative caption-bounded regions. It retains author text while excluding repeated first-page affiliation blocks misclassified as tables. The 64-crop budget and unavailable/ambiguous geometry produce explicit missing-region outcomes. Inferred regions remain marked `caption-region-inferred`; usable text does not imply proven visual completeness. No inferred region automatically authorizes a paid OCR provider.

Each source has:

- `<pdfStorageKey>.structured-document.json`: structured text, admitted by input SHA-256 and the parser artifact revision.
- `<pdfStorageKey>.structured-crops/<inputSha256>/manifest.json`: planned/ready crop IDs, retryable or permanent failures, and the completed text/visual quality summary. Quality is null until every planned crop is stored.
- Immutable `<cropId>.png` images. IDs include the pinned build, schema/processor version, crop recipe, page, and rectangle.

The renderer receives one PDF per batch of at most eight regions. It streams bounded PNG rows; Core stores each result independently. An incomplete batch persists its manifest and fails the acquisition checkpoint. Workflow retries retain the structured document and successful PNGs and render only missing crops. Permanent input failures stop retries; transport, capacity, and server errors remain retryable. Container queue wait expiry rejects only that waiting request; the active processing watchdog starts after admission.

When changing the document-worker build or crop algorithm, update the explicit artifact/recipe versions in `zotero-sdt.ts` alongside the pinned Docker build as applicable. Do not overwrite old crop objects: stored content may still reference their immutable URLs. Media routes require crop IDs with a recipe digest.

#### Source ownership

R2 holds each PDF once at `blobs/<sha256>`, with its crops under `blobs/<sha256>.structured-crops/`. Uploads and fetched PDFs share that key; `stored_objects` rows are ownership references to it, and `resources.pdf_hash` names the PDF a Resource reads as. An upload identified as a paper becomes that paper: its parse is the paper's full text, and a corpus Resource with that `pdf_hash` makes the PDF and its crops public. An unidentified upload stays a private file. Core takes Web's stored-blob advisory lock while committing a Resource with a `pdf_hash`, so Web purges bytes only when no ownership row or corpus Resource references them.

#### Operator verification

Run `pnpm lint` and `pnpm run typecheck` from this workspace. Verify acquisition, persistence, and applicable follow-ups with representative resources through the existing admission APIs. Temporary verification or investigation scripts belong outside the repository.

Deploy the Web media/reading changes and the Core Worker **with its updated Zotero container image** before admitting new processing. A Worker-only deployment with `--containers-rollout=none` cannot activate the new batch endpoint.

After deployment, reprocess an uploaded PDF through Web's `DomainRpc.admitStoredBlobProcessing({ objectId: <stored-object-id>, retry: true })`; Web validates ownership and admits the Core job. Do not pass its canonical paper ID. Use Core's `resyncResource` for a resource with an external URL. Inspect Workflow status, the crop manifest and its quality summary, the persisted translations, and owner/non-owner reads. A completed canonical row alone does not prove all follow-ups succeeded. No production backfill is implicit in a code deployment.

The Cocoa regression was checked against the user-supplied 23-page PDF: the new plan has 10 figures and 4 genuine tables; 19 affiliation crops are excluded. All 14 regions rendered with the pinned Zotero runtime, and all five recovered figures were visually inspected. The full copyrighted PDF is not committed as a fixture.

## AI Pipeline

| Stage               | Model                        | What it does                                                               |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| **Summary**         | AI Gateway structured output | Generate only when the source has no summary; language is detected locally |
| **Classification**  | AI Gateway structured output | Tags and keywords after the resource is readable                           |
| **Translation**     | AI Gateway text models       | Admitted persisted Resources → zh-Hant title, summary, and content         |
| **Retrieval Index** | Workers AI bge-m3, Vectorize | Chunked semantic retrieval over enriched corpus documents                  |

Summary generation and background classification are separate structured calls. Translation runs in its own Workflow, so localization failure cannot invalidate an already persisted canonical Resource.

Core preserves a nonblank source summary or abstract. When it is missing, the existing analysis call also generates a summary in the original language; a body excerpt is not a source summary. Each summary language then gets a card from one call: a summary in that language and, when the original is written in another, its title translated alongside. Content translation is separate: a `translation` row holds only translated content, made automatically for monitor discoveries or on a reader's request.

## Stack

| Layer         | Technology                             |
| ------------- | -------------------------------------- |
| Runtime       | Cloudflare Workers (V8 isolates)       |
| Orchestration | Cloudflare Workflows                   |
| Database      | PostgreSQL (via Cloudflare Hyperdrive) |
| LLM           | Cloudflare AI Gateway                  |
| Search        | Cloudflare Vectorize                   |
| Twitter Data  | Kaito API (third-party)                |

## Self-Hosting

The one-click Deploy button above handles Worker + Workflows, but **Queues, Hyperdrive, the database, and secrets need manual setup**. Full walkthrough:

### 1. Database

You need a PostgreSQL instance. Production currently runs on PlanetScale Postgres through Cloudflare Hyperdrive.

The canonical app-owned schema lives in `web-tanstack/src/server/db/schema.ts`, with its migrations (including DB-only functions and triggers) in `web-tanstack/drizzle/`. Core uses Drizzle's parameterized SQL over Hyperdrive without maintaining a second table schema. Schema changes require Web migration replay (`pnpm db:migrate`) and `pnpm db:drift-check` against a disposable database.

### 2. Hyperdrive binding

Create a Hyperdrive that points to your database:

```bash
pnpm exec cf hyperdrive create --body '{"name":"newsence-db","origin":{"scheme":"postgres","host":"host","port":5432,"database":"dbname","user":"user","password":"pass"}}'
```

Copy the returned ID into `cloudflare.config.ts` under `bindings.hyperdrive({ id })`.

### 3. Cloudflare Workflows

Workflows are provisioned automatically on first deploy from `exports` in `cloudflare.config.ts`; code reaches them through `coreExports` (`src/exports.ts`).

The `resource-search-sync` Queue is provisioned from `cloudflare.config.ts`. Resource
and translation Workflows durably enqueue a Resource ID after PostgreSQL commits;
the Queue consumer rewrites the derived corpus vectors with native per-message
acknowledgement and bounded retries. Workflow failures remain visible through
Cloudflare's native Workflow status and Workers Logs.

### 4. Secrets

AI analysis uses the Workers AI binding through AI Gateway, so no external LLM secret is required. Platform/API secrets are declared in `cloudflare.config.ts`:

```bash
pnpm exec cf workers secrets update KAITO_API_KEY --worker newsence-core --text <value>    # Twitter monitoring
pnpm exec cf workers secrets update YOUTUBE_API_KEY --worker newsence-core --text <value>  # YouTube monitoring
pnpm exec cf workers secrets update OPENALEX_API_KEY --worker newsence-core --text <value> # Paper metadata enrichment
```

Zotero Structured Document Text is the primary PDF parser. A private upload is
streamed to a sleeping `basic` Cloudflare Container once; Core derives its
Markdown, bibliography, citation links, and PDF source coordinates from that
single document and stores the bounded SDT JSON beside the original R2 object,
guarded by the source SHA-256. The same document's first page and PDF properties
supply an upload's DOI or arXiv id, and Crossref enriches the resulting bibliography.

The Container RPCs return native HTTP responses. Core reads and validates them
inside the acquisition Workflow.

A PDF without a text layer fails with a non-retryable "OCR is required" error;
there is no OCR fallback. OpenAlex key-bearing content URLs remain local-only.

### 5. Deploy

```bash
pnpm install
pnpm exec cf deploy
```

Or run locally with `pnpm dev` (uses `cf dev -- --test-scheduled`, so you can curl `/__scheduled?cron=*/5+*+*+*+*` to run due monitors manually).

## API surface

Core exposes no product HTTP API; its default fetch handler only returns 404. App imports first call `resolveResourceUrls` once per batch to match normalized URLs and exact identifiers against existing corpus resources. Web rechecks and saves existing IDs; aliases of a missing URL share one draft. Draft dispatch uses a Cloudflare service-binding RPC with a Workflow instance ID, original fetch URL, and user-owned `saveTarget`; monitors and derived subjects enqueue the same draft target internally without one. Uploaded blobs and explicit resyncs use persisted resource IDs. URL acquisition is an internal stage of the canonical resource Workflow.

URL/platform acquisition and app-owned R2 PDF reads each produce one canonical processing aggregate. Core selects any academic replacement content first, commits canonical Resource state through Drizzle/Hyperdrive, and then runs a separate durable Web step only when user save/container/file ownership must be updated.

## Hosted MCP

The commonplot app exposes an anonymous, read-only hosted
[MCP](https://modelcontextprotocol.io) endpoint at
`https://www.commonplot.co/api/mcp`. It supports public corpus search and
bounded resource reads. The retired local CLI/MCP package is not part of this
Worker.

## Architecture

```
src/
├── index.ts          # service RPC, cron, and queue entrypoints (wiring only)
├── contracts/        # schemas and pure rules: acquired/normalized resource, targets, images, translation policy, the Markdown dialect
├── services/         # external systems: AI, Crossref, Hosted Images, PDF parsers, YouTube captions
├── adapters/         # provider acquisition without a database; acquire.ts routes and normalizes
├── store/            # all canonical SQL: resources, translations, references, monitors, withCoreDb
├── monitors/         # feed, YouTube and X monitor adapters and their runner
├── workflows/        # processing, translation, references, and progress reporting
└── search/           # corpus vectors, queue consumer, retrieval, and backfill
```

## Environment Variables & Bindings

Bindings (in `cloudflare.config.ts`):

| Binding                            | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `HYPERDRIVE`                       | Hyperdrive connection to your Postgres                   |
| `RESOURCE_SEARCH_SYNC_QUEUE`       | Durable vector sync after canonical PostgreSQL writes    |
| `R2`                               | App-owned uploaded PDF reads                             |
| `IMAGES`                           | Stream remote resource images to Cloudflare Images       |
| `AI`                               | Workers AI binding for AI Gateway text calls             |
| `CORPUS_VECTORS`                   | `newsence-corpus-vectors-v1` public corpus vectors       |

Secrets (via `cf workers secrets update --worker newsence-core`):

| Variable           | Required | Description                             |
| ------------------ | -------- | --------------------------------------- |
| `KAITO_API_KEY`    | Yes      | Enables Twitter monitoring              |
| `YOUTUBE_API_KEY`  | Yes      | Enables YouTube channel monitoring      |
| `OPENALEX_API_KEY` | Yes      | Enables exact paper metadata enrichment |

### Corpus vectors

`CORPUS_VECTORS` serves `newsence-corpus-vectors-v1` (bge-m3, 1024-d): a document
vector and up to 32 chunk vectors per corpus Resource, filtered by `kind` and
`published_at`. Public search and related Resources share it. PostgreSQL remains
canonical; Vectorize stores only keyed vectors. Private Resources and images never
enter the index. See `CORPUS_VECTORS_RUNBOOK.md` for the vector layout and the
backfill Workflow.

### Paper enrichment

Exact DOI, arXiv, and OpenAlex identities resolve through the official OpenAlex
REST API. Identifiers found on an uploaded PDF's first page count only when the
resolved title appears on that page; otherwise the upload stays a private file.
A linked paper with neither full text nor an abstract fails instead of storing
its landing page.

## Adding an Ingest Adapter

Ingest adapters live in `adapters/*.ts` with the
discovery/scrape/process pieces they actually need. New saved URLs and monitored
items enter the Workflow as immutable drafts; only successful processing creates
or merges a canonical `resources` row. Core owns canonical source and subject
relations in the same Drizzle transaction; Web applies an optional user-owned
save/container/file target in the next durable step. App-owned uploads remain
the explicit record-first exception and create `stored_objects` plus `resources`
before Core reads the stored blob.

Keep the axes separate: acquisition (generic web or a specialized adapter) is
not canonical `ResourcePlatform` (`youtube`, `twitter`, `hackernews`, `lesswrong`, or null),
`ResourceKind` (`blog`, `forum`, `post`, `video`, `paper`, `image`, `file`), blob
representation (MIME/filename/size/pages), or lifecycle origin (`source`,
`saved_url`, `upload`, `generated`). External URL PDFs are checkpointed in R2
before parsing; uploaded PDF extraction reads the app-owned blob. Neither
representation is an additional identity value.

Curated monitors (`monitors` table) are a `feed` URL, a `youtube` channel id or
a `twitter` handle, with whatever their adapter keeps between checks in `state`.
The 5-minute cron claims the active monitors whose `next_check_at` has passed;
after a check the next one is a quarter of the week's average gap between entries,
within the adapter's bounds. A failure keeps the monitor active and doubles the
wait per failure in a row, up to a day, so a source that recovers is read again
on its own; from four failures in a row its line logs `outcome: 'failing'`, and
`failures`/`last_error` show it in the table. Only a person sets `paused`. Every
check logs one `tag: 'MONITOR'` line, and monitors of a kind failing with the
same error share one. Entries acquire their
canonical URL, where normal resource detection selects LessWrong and YouTube
adapters when applicable.

Minimum to add a new ingest source:

1. **Adapter file** (`adapters/foo.ts`) — acquisition only.
2. **Canonical adapter output** — normalize provider data into common creators,
   versioned kind metadata, exact identifiers, and an optional immediate subject.
3. **Identity contract** — add the exact locator and valid `(kind, platform)` pair.
4. **Monitor** (optional) — a `MonitorAdapter` in `monitors/` and its kind in `contracts/monitors.ts`, only when discovery is not already a feed.

The new resource goes through the same Workflow pipeline as every other ingest
source. Resolver owns the final identity, the narrowed kind handler owns
provider behavior, and Core's canonical transaction owns persistence. Adding a
platform must not add a provider branch to common Workflow or Web rendering.

## License

MIT
