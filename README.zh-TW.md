<div align="center">

# newsence

**幫助 LLM 理解你的世界的內容發現引擎**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![npm: newsence](https://img.shields.io/npm/v/newsence?label=npm%3A%20newsence&color=cb3837&logo=npm)](https://www.npmjs.com/package/newsence)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?logo=anthropic&logoColor=white)](https://www.newsence.app/api/mcp)
[![Website](https://img.shields.io/badge/newsence.app-live-00c853)](https://www.newsence.app)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/newsence)

[English](README.md) | [繁體中文](README.zh-TW.md)

</div>

---

## newsence 是什麼？

[**newsence.app**](https://www.newsence.app) 的引擎。支援 RSS、Twitter/X、YouTube、Hacker News、一般網頁與上傳檔案，自動進行中英雙語 AI 分析並保留每筆 resource 的實體註記，再將完成 enrichment 的 corpus resource 同步到 Cloudflare AI Search。

## 支援平台

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| 平台            | 類型   | 排程       | 說明                                             |
| --------------- | ------ | ---------- | ------------------------------------------------ |
| **RSS 訂閱**    | 監控   | 每 5 分鐘  | 抓取 feed、依 URL 去重、偵測 HN 連結             |
| **Twitter/X**   | 監控   | 每 6 小時  | 透過 Kaito API 追蹤用戶 — 推文、串文、長文、媒體 |
| **YouTube**     | 監控   | 每 30 分鐘 | Atom feed → 影片資訊、字幕、章節、AI 精華段落    |
| **Hacker News** | 處理器 | 經由 RSS   | 偵測 HN 連結 → Algolia 取評論 → 生成編輯筆記     |
| **網頁**        | 爬蟲   | saved URL  | 全文擷取（Readability + Cheerio）、OG metadata   |
| **App 輸入**    | 入口   | 即時       | Service-binding RPC — saved URL/blob acquisition + enrichment；membership 由 app 擁有 |

所有 provider 只輸出不帶產品 identity 的 acquisition material；單一 resolver
決定最終 Resource identity，再由 exhaustive kind handler 進入共用的 AI 與
graph-persistence tail。

## 運作流程

每個 resource 經過自動化 workflow，各步驟獨立重試：

```
內容進入（source monitor / saved URL / uploaded blob / resync）
  │
  ├─ 1. 取得內容 ──────────── 抓取 URL draft，或讀取／抽取 app-owned blob
  ├─ 2. 決定 identity ─────── 完成 kind/platform、paper metadata 與 subject intent
  ├─ 3. AI 分析 ───────────── AI Gateway calls → 中英標題、摘要、標籤、關鍵字、實體
  ├─ 4. 託管圖片 ──────────── 將 canonical 遠端圖片串流到 Cloudflare Images
  ├─ 5. 最終寫入 DB ───────── 建立或更新 canonical URL resource；enrich 既有 stored blob
  └─ 6. 後續工作 ──────────── corpus 結果才 attach／enqueue subject、翻譯與同步 AI Search
```

URL、source 與 derived-subject 都以 immutable Workflow draft 傳遞，只有第 5
步成功時才建立 Resource。App-owned upload 因 ownership、quota 與 blob locator
已存在，是唯一 record-first 例外。每個 durable step 各自重試。

## AI 管線

| 階段         | 模型              | 說明                                                        |
| ------------ | ----------------- | ----------------------------------------------------------- |
| **分析**     | AI Gateway text model | Resource → 中英標題、摘要、標籤與關鍵字                     |
| **實體提取** | AI Gateway JSON model | Resource → 具名實體（人物、組織、產品、技術、事件），含中英名稱 |
| **搜尋索引** | Cloudflare AI Search  | 對完成 enrichment 的 corpus 文件提供 hybrid retrieval       |

翻譯/摘要與分類/實體是分開的 structured calls，避免其中一個 schema 失敗就讓整個 resource 落入 fallback。

### 實體資料策略

Core 會正規化明顯重複項目、限制實體類型、排除泛詞與來源別名，並限制每筆 resource 儲存的實體數量。

Collection Wiki 產品介面雖已退役，entity extraction 仍刻意保持啟用。衍生註記只存在 `resources.entities`，供未來搜尋或呈現功能使用；目前沒有全域正規化 entity graph 或 reverse index。只有在真實產品需求需要跨 resource 查詢時，才應重新加入正規化 entity tables。

## 技術棧

| 層級         | 技術                                                |
| ------------ | --------------------------------------------------- |
| 運行環境     | Cloudflare Workers（V8 isolates）                   |
| 任務編排     | Cloudflare Workflows                                |
| 資料庫       | PostgreSQL（透過 Cloudflare Hyperdrive）            |
| 大語言模型   | Cloudflare AI Gateway                               |
| 搜尋         | Cloudflare AI Search                                |
| Twitter 數據 | Kaito API（第三方）                                 |

## 自行部署

上方的一鍵 Deploy 按鈕會幫你建好 Worker + Workflows，**但 Queues、Hyperdrive、資料庫、secrets 需要手動設定**。完整步驟：

### 1. 資料庫

需要一個 PostgreSQL。正式環境目前透過 Cloudflare Hyperdrive 連到 PlanetScale Postgres。

App-owned canonical schema 位於 `web-tanstack/prisma/schema.prisma`，DB-only constraints 與 indexes 則位於 `web-tanstack/prisma/manual-indexes.sql`。Core 透過 Hyperdrive 使用 Drizzle 的參數化 SQL，不再維護第二份 table schema。schema 或 resource/source domain 變更後請執行 `pnpm check:db-contract`。

### 2. Hyperdrive binding

建一個 Hyperdrive 指向你的資料庫：

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

把回傳的 ID 填進 `wrangler.jsonc` 的 `hyperdrive[].id` 欄位。

### 3. Cloudflare Workflows

Workflows 會在第一次 deploy 時透過 `wrangler.jsonc` 裡的 `workflows` bindings 自動建立。

Workflow lifecycle errors 共用一條 event queue。先建立 queue 與 dead-letter queue，再訂閱 resource Workflow 的 error event：

```bash
pnpm exec wrangler queues create workflow-errors-core
pnpm exec wrangler queues create workflow-errors-dlq-core
pnpm exec wrangler queues subscription create workflow-errors-core \
  --source workflows.workflow \
  --workflow-name newsence-resource-processing-v2 \
  --events instance.errored \
  --name newsence-resource-processing-errors
```

consumer 會記錄所有已訂閱的 Workflow errors。失敗的 monitored-source draft 只會得到一次延遲且 deduplicated 的 recovery；platform detection 與 acquisition 仍留在原本的 resource Workflow 內。

### 4. Secrets

AI 分析透過 Workers AI binding 與 AI Gateway 執行，不需要外部 LLM secret。平台/API secrets 由 Wrangler config 設為必填：

```bash
wrangler secret put KAITO_API_KEY            # Twitter 監控
wrangler secret put YOUTUBE_API_KEY          # YouTube 監控
wrangler secret put OPENALEX_API_KEY          # 論文 metadata enrichment
```

### 5. 部署

```bash
pnpm install
pnpm run deploy
```

或本地跑 `pnpm dev`（用 `wrangler dev --test-scheduled`，可以 curl `/__scheduled?cron=*/5+*+*+*+*` 手動觸發 RSS cron）。

## API Surface

Core 沒有產品 HTTP API；default fetch handler 只回傳 404。App URL import 透過 Cloudflare service-binding RPC 傳入 Workflow instance ID、URL 與 admission intent；monitor 與 derived subject 在 Core 內排入相同 draft target。只有 uploaded blob 與 explicit resync 傳入已持久化的 resource ID。URL acquisition 只存在於 canonical resource Workflow 內部。

URL／platform acquisition 與 app-owned R2 PDF 讀取都只 materialize 一個 canonical processing aggregate。Core 先選定可能的學術替代正文，再透過 app Domain transaction commit；只有 corpus 結果會執行 subject、translation 與 AI Search follow-up。

## Hosted MCP

newsence app 在 `https://www.newsence.app/api/mcp` 提供匿名、唯讀的 hosted
[MCP](https://modelcontextprotocol.io) endpoint，支援公開 corpus 搜尋與有限長度的
resource 讀取。已退役的本機 CLI／MCP 套件不屬於這個 Worker。

## 架構

```
src/
├── index.ts              # service RPC、cron 與 Workflow-error Queue entrypoints
├── entities/             # resource-local entity normalization
├── shared/               # 小型跨子系統 primitives
│   ├── resource.ts       # identity、identifier、canonical metadata contracts
│   ├── image-mapping.ts  # canonical Hosted Images 欄位 mapping
│   └── url.ts            # URL normalization 與精確 platform locator
├── ingest/               # ── resource 入庫 pipeline（開源核心）──
│   ├── workflow.ts       # target validation、processing 與 draft recovery Workflows
│   ├── monitored-source.ts # source resolution、狀態與 deterministic draft admission
│   ├── stored-resource.ts # record-first blob 與 resync 的窄 projection
│   └── platforms/        # 每個來源或 stage 一個檔案
│       ├── rss.ts        # feed polling
│       ├── twitter.ts    # source monitor
│       ├── twitter-acquisition.ts # tweet acquisition
│       ├── youtube-acquisition.ts # transcript/highlights
│       ├── hackernews.ts # HN processor
│       ├── paper.ts      # OpenAlex enrichment stage
│       └── pdf.ts        # PDF text extraction stage
├── operations/           # operator 觸發的 durable jobs
│   └── search-index-rebuild.ts # AI Search 全量 rebuild
└── search-index.ts        # runtime AI Search projection、同步與排序檢索
```

## 環境變數與 Bindings

Bindings（在 `wrangler.jsonc` 裡設定）：

| Binding            | 用途                                        |
| ------------------ | ------------------------------------------- |
| `HYPERDRIVE`       | 連線到你的 Postgres                         |
| `RESOURCE_PROCESSING_V2_WORKFLOW` | 抓取、解析、分類並寫回 canonical resource |
| `RESOURCE_DRAFT_RECOVERY_WORKFLOW` | 對失敗的 autonomous source／subject draft 執行一次有界的延遲 restart |
| `RESOURCE_TRANSLATION_V2_WORKFLOW` | 將已持久化的 resource 翻譯成繁體中文 |
| `SEARCH_INDEX_GENERATION_5_REBUILD_WORKFLOW` | 全量重建並驗證 generation-5 搜尋索引 |
| `workflow-errors-core` | 接收已訂閱 Workflow lifecycle errors 的 Queue consumer |
| `R2`               | 讀取 app-owned uploaded blob，供 PDF extraction 使用 |
| `IMAGES`           | 將遠端 resource 圖片串流上傳至 Cloudflare Images |
| `AI`               | Workers AI binding（AI Gateway 文字呼叫）   |
| `AI_SEARCH`        | `newsence-corpus-v6` canonical public corpus |

Secrets（透過 `wrangler secret put` 設定）：

| 變數                           | 必要 | 說明                          |
| ------------------------------ | ---- | ----------------------------- |
| `KAITO_API_KEY`                | 是   | 啟用 Twitter 監控             |
| `YOUTUBE_API_KEY`              | 是   | 啟用 YouTube 頻道監控         |
| `OPENALEX_API_KEY`             | 是   | 啟用精確論文 metadata enrichment |

## Canonical resource identity

`ResourceKind` 是產品呈現語意，合法的 `(kind, resource_platform)` 組合只有
`blog / null`、`blog / lesswrong`、`forum / hackernews`、`post / twitter`、
`video / youtube`、`paper / null`、
`image / null` 與 `file / null`。PDF 是 representation，不是另一個 kind；
一般 PDF 是 `blog`；HN/Twitter carrier 保持原 identity，學術辨識後透過
`subject_resource_id` 指向另一筆 canonical `paper / null` resource。

Web 只送一個 monitor 輸入，由 Core 自動辨識 feed URL、YouTube 頻道或
X/Twitter 帳號。`Source.monitorKind` 只保存 `feed | twitter` 這個 cron
路由；feed entry 進入正常 resource 偵測後，才選擇 LessWrong 或 YouTube
adapter。

AI Search 沿用 `newsence-corpus-v6`。PostgreSQL 是 canonical source，Core
只把 keyed search document 同步進 AI Search；rebuild 的 durable 狀態、重試、
錯誤與 output 直接使用 Cloudflare Workflow。實體 Workflow 是
`newsence-search-index-generation-5-rebuild`，class 是
`SearchIndexGeneration5RebuildWorkflow`，目前 runner 為
`search-index-rebuild-generation-5-native-v2`。

## 新增擷取 adapter

擷取 adapter 集中在 `ingest/platforms/*.ts`，只放它真正需要的
discovery / scrape / process 邏輯。App-owned saved URL 以 Workflow draft
進入 Core，成功處理後才建立 canonical row；upload 則先寫入 `resources`
與 `user_files`，再以 `resourceId` 啟動 Workflow。Core 透過
`ingest/stored-resource.ts` 讀取既有 upload 或 resync rows；processed graph
寫入統一跨越 app-owned `DOMAIN.persistResolvedResource` transaction
boundary。Draft admission 直接跟隨 Workflow payload，translation input query 則與唯一的
consumer 放在 `translation-workflow.ts`。

各軸要分開：acquisition（generic web 或專用 adapter）不是 canonical
`ResourcePlatform`（`youtube`、`twitter`、`hackernews`、`lesswrong` 或 null），也不是
`ResourceKind`（`blog`、`forum`、`post`、`video`、`paper`、`image`、`file`）、
blob representation（MIME／檔名／大小／頁數）或 lifecycle origin
（`source`、`saved_url`、`upload`、`generated`）。PDF 解析和外部 paper
paper enrichment 是 workflow stage，依 row 內容或 metadata
觸發，不是新的 identity 值。

新增一個來源最少要做：

1. **Adapter file**（`ingest/platforms/foo.ts`）— discovery / scrape helpers 和可選自訂 processor。
2. **Canonical fields** — provider payload 在 Core 內正規化成 creators、kind metadata、identifiers 與 optional subject；不保存 provider JSON。
3. **Monitor**（可選）— 如果來源可以輪詢，從 `src/index.ts` 接上 cron handler。
4. **Workflow hook**（可選）— 只有在來源需要不同於預設 AI merge 的行為時才加。

新 resource 一樣走 Workflow pipeline。只有當產品真的需要持久化的
platform-specific 行為或呈現時才新增 canonical platform；RSS feed 或
一般網頁不算。

## 授權

MIT
