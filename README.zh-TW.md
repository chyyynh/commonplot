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

[**newsence.app**](https://www.newsence.app) 的引擎。支援 RSS、Twitter/X、YouTube、Hacker News、一般網頁與上傳檔案，自動進行結構化 AI 分析與繁中翻譯並保留每筆 resource 的實體註記，再將完成 enrichment 的 corpus resource 同步到 Cloudflare AI Search。

## 支援平台

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| 輸入 | 取得內容的流程 |
| --- | --- |
| **網頁 URL** | 抓取／偵測轉址 → HTML 正文與來源資料 → Markdown；PDF 回應交給 PDF parser |
| **上傳 PDF** | 讀取擁有權所屬的 R2 blob → Zotero 正文／圖片與第一頁識別碼 → OpenAlex，標題出現在第一頁才採用；上傳檔維持私人檔案，辨識出的論文以授權全文或摘要公開 |
| **論文** | 精確 URL 或 PDF identity → 網頁查 OpenAlex／PDF 查 Crossref → canonical 識別碼與書目；選擇性取得 OpenAlex 全文 PDF |
| **Twitter/X** | twitterapi.io → 推文或長文 Markdown、媒體與連結主題；監控每 6 小時以 cursor 分頁 |
| **YouTube** | 影片資料 → 並行頻道頭像與字幕 → 章節或 AI 精華 → 字幕與 Resource 在同一交易寫入 |
| **Hacker News** | Firebase 主文與排序留言 → Markdown 討論；外部文章保留為獨立 subject |
| **LessWrong** | GraphQL 文章 → 原生 Markdown 與來源資料 |
| **RSS / Atom / JSON Feed** | 抓取 → feed parser → 正規化 URL drafts → 一般 acquisition；每 5 分鐘執行，YouTube feed 間隔 30 分鐘 |

單一 URL detector 先選出負責的 platform adapter。每個 platform/kind adapter
自行負責來源解析、identity 與 Resource 輸出；共用部分只有輸出契約與來源提示小工具，
沒有泛型 materializer。Workflow 再將輸出交給 analysis、image hosting 與 persistence。

Web 與 PDF adapter 直接產出可讀的 Resource；paper resolution 在這份 Resource 上補齊書目 identity。
修改平台行為從對應 adapter 開始，dispatcher 只負責路由。新增平台也要同步更新
`src/shared/resource.ts` 的 identity 契約與資料庫 constraints。Debug 時先檢查 acquisition step
輸出的 Resource，再追 analysis、canonical persistence，以及獨立的 app save／後續工作。

## 運作流程

每個 resource 經過自動化 workflow，各步驟獨立重試：

```
內容進入（source monitor / saved URL / uploaded blob / resync）
  │
  ├─ 1. 取得內容 ──────────── 抓取 URL draft，或讀取／抽取 app-owned blob
  ├─ 2. 決定 identity ─────── 完成 kind/platform、paper metadata 與 subject intent
  ├─ 3. 準備儲存 ──────────── 本機判斷語言；只補缺少的摘要，與圖片託管並行
  ├─ 4. 寫入 DB ───────────── 寫入 canonical／私人內容；發布符合條件的公開 PDF 圖片
  ├─ 5. 原文可讀 ──────────── 套用 user save，回報資源已可閱讀
  └─ 6. 後續工作 ──────────── 標籤／關鍵字分類後派送索引；翻譯、引用與 subject 獨立執行
```

URL、source 與 derived-subject 都以 immutable Workflow draft 傳遞，只有第 4
步成功時才建立 Resource。App-owned upload 因 ownership、quota 與 blob locator
已存在，是唯一 record-first 例外。Source monitor 會先用 PostgreSQL 的 canonical
Resource 過濾已完成項目；只有 in-flight 與 failed attempts 使用短期原生 Workflow
retention。每個 durable step 各自重試。

PDF 圖片辨識、來源權限、快取版本與重新處理流程，見 [PDF processing](README.md#pdf-processing-and-recovery)。

驗證執行 `pnpm lint` 與 `pnpm run typecheck`，並透過既有 admission API，以代表性資源核對抓取、持久化與適用的後續工作。臨時驗證與探索腳本不放進 repository。

## AI 管線

| 階段         | 模型              | 說明                                                        |
| ------------ | ----------------- | ----------------------------------------------------------- |
| **摘要**     | AI Gateway structured output | 來源缺少摘要才生成；語言由本機 package 判斷                    |
| **分類**     | AI Gateway structured output | 原文可讀後才產生標籤與關鍵字                                  |
| **翻譯**     | AI Gateway text models      | 符合條件的已持久化 Resource → 繁中標題、摘要與正文             |
| **搜尋索引** | Cloudflare AI Search  | 對完成 enrichment 的 corpus 文件提供 hybrid retrieval       |

摘要生成與背景分類是分開的 structured call；翻譯在獨立 Workflow 執行，因此 localization 失敗不會讓已寫入的 canonical Resource 失效。

Core 優先保留非空白的來源摘要或論文 abstract；缺少時由既有的分析呼叫一併生成原文語言摘要，正文截片不視為來源摘要。Metadata localization 完整翻譯已保存的摘要，不從正文自行補寫；舊資料沒有摘要時只翻譯標題，重新處理後才會補上原文摘要。

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

App-owned canonical schema 位於 `web-tanstack/prisma/schema.prisma`，DB-only constraints 與 indexes 則以 SQL 版本化於 `web-tanstack/prisma/migrations/`。Core 透過 Hyperdrive 使用 Drizzle 的參數化 SQL，不再維護第二份 table schema。Schema 變更需在可丟棄的資料庫執行 Web migration replay 與 `pnpm db:drift-check`。

### 2. Hyperdrive binding

建一個 Hyperdrive 指向你的資料庫：

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

把回傳的 ID 填進 `wrangler.jsonc` 的 `hyperdrive[].id` 欄位。

### 3. Cloudflare Workflows

Workflows 會在第一次 deploy 時透過 `wrangler.jsonc` 裡的 `workflows` bindings 自動建立。

`resource-search-sync` Queue 由 `wrangler.jsonc` 自動建立。Resource 與
translation Workflows 只在 PostgreSQL commit 後 durable enqueue Resource ID；
Queue consumer 再以原生逐訊息 ack 與有限 retry 更新衍生的 AI Search 文件。
Workflow failures 直接透過 Cloudflare 原生 Workflow status 與 Workers Logs 查看。

### 4. Secrets

AI 分析透過 Workers AI binding 與 AI Gateway 執行，不需要外部 LLM secret。平台/API secrets 由 Wrangler config 設為必填：

```bash
wrangler secret put KAITO_API_KEY            # Twitter 監控
wrangler secret put YOUTUBE_API_KEY          # YouTube 監控
wrangler secret put OPENALEX_API_KEY          # 論文 metadata enrichment
wrangler secret put LLAMA_CLOUD_API_KEY       # 付費 PDF fallback
wrangler secret put LLAMA_CLOUD_PROJECT_ID    # 此 deployment 專用的 Llama Cloud project
```

Zotero Structured Document Text 是主要 PDF parser。私人上傳只會串流到
可休眠的 `basic` Cloudflare Container 一次；Core 從同一份 document 產生
Markdown、bibliography、citation links 與 PDF source coordinates，並把有大小
上限的 SDT JSON 存在原始 R2 object 旁，以來源 SHA-256 驗證。同一份 document 的
第一頁與 PDF 屬性提供上傳檔的 DOI／arXiv id，Crossref 則補齊 bibliography metadata。

LlamaParse 保留為 local-first OCR fallback。Web 負責產品 kill switch 與 Autumn
資格，並在 authenticated URL 與新上傳 PDF workflow 附上單份文件的頁數
grant。Core 只在 SDT extraction 為空、degraded 或大部分頁面只有圖片時執行
已授權的 fallback，且獨立強制 100 頁與 25 MiB 安全上限。私人上傳使用暫時的
Llama Cloud file，Core 會在 fallback 完成或中止時刪除；不明確的 provider
mutation 會直接失敗，並留下穩定的 external ID 供 operator 清理。帶 OpenAlex
key 的 content URL 仍只在本地處理。Provider adapter 固定使用美國 API、
`cost_effective` tier 與具日期的 parser version。只有在明確授權 development
smoke 並記錄實際 credits 後，才可開啟 Web grant。

### 5. 部署

```bash
pnpm install
pnpm run deploy
```

或本地跑 `pnpm dev`（用 `wrangler dev --test-scheduled`，可以 curl `/__scheduled?cron=*/5+*+*+*+*` 手動觸發 RSS cron）。

## API Surface

Core 沒有產品 HTTP API；default fetch handler 只回傳 404。App URL import 透過 Cloudflare service-binding RPC 傳入 Workflow instance ID、URL 與使用者的 `saveTarget`；monitor 與 derived subject 在 Core 內排入不含 save target 的相同 draft。只有 uploaded blob 與 explicit resync 傳入已持久化的 resource ID。URL acquisition 只存在於 canonical resource Workflow 內部。

URL／platform acquisition 與 app-owned R2 PDF 讀取各自產生一個 canonical processing aggregate。Core 先選定可能的學術替代正文，再透過 Drizzle／Hyperdrive commit canonical Resource；只有需要處理使用者 save／container／file ownership 時，才在下一個 durable step 呼叫 Web。

## Hosted MCP

newsence app 在 `https://www.newsence.app/api/mcp` 提供匿名、唯讀的 hosted
[MCP](https://modelcontextprotocol.io) endpoint，支援公開 corpus 搜尋與有限長度的
resource 讀取。已退役的本機 CLI／MCP 套件不屬於這個 Worker。

## 架構

```
src/
├── index.ts              # service RPC、cron 與 Workflow-error Queue entrypoints
├── shared/               # 小型跨子系統 primitives
│   ├── resource.ts       # identity、identifier、canonical metadata contracts
│   ├── image-mapping.ts  # canonical Hosted Images 欄位 mapping
│   └── db.ts             # Drizzle over Hyperdrive
├── ingest/               # ── resource 入庫 pipeline（開源核心）──
│   ├── workflow.ts       # durable resource processing 與 follow-up orchestration
│   ├── analysis.ts       # AI 分析與 resource-local entity normalization
│   ├── acquisition.ts    # 單次 platform detection 與 adapter dispatch
│   ├── resource-persistence.ts # canonical Resource transaction
│   ├── translation-workflow.ts # durable translation 與 canonical writeback
│   └── platforms/        # 每個來源或 stage 一個檔案
│       ├── rss.ts        # feed polling
│       ├── twitter.ts    # source monitor
│       ├── twitter-acquisition.ts # tweet acquisition
│       ├── youtube.ts             # 來源解析、擷取、逐字稿／精華
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
| `RESOURCE_TRANSLATION_V2_WORKFLOW` | 將已持久化的 resource 翻譯成繁體中文 |
| `SEARCH_INDEX_REBUILD_WORKFLOW` | 全量重建並驗證 canonical 搜尋索引 |
| `RESOURCE_SEARCH_SYNC_QUEUE` | canonical PostgreSQL 寫入後 durable 同步 AI Search |
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
| `LLAMA_CLOUD_API_KEY`          | 是   | 此 deployment 的 LlamaParse API key |
| `LLAMA_CLOUD_PROJECT_ID`       | 是   | 此 deployment 隔離使用的 Llama Cloud project |

## Canonical resource identity

`ResourceKind` 是產品呈現語意，合法的 `(kind, resource_platform)` 組合只有
`blog / null`、`blog / lesswrong`、`forum / hackernews`、`post / twitter`、
`video / youtube`、`paper / null`、
`image / null` 與 `file / null`。PDF 是 representation，不是另一個 kind；
一般 PDF 是 `blog`；HN/Twitter carrier 保持原 identity，學術辨識後透過
`subject_resource_id` 指向另一筆 canonical `paper / null` resource。

Curated source 的 `Source.monitorKind` 只保存 `feed | twitter` 這個 cron
路由；feed entry 進入正常 resource 偵測後，才選擇 LessWrong 或 YouTube
adapter。

AI Search 沿用 `newsence-corpus-v6`。PostgreSQL 是 canonical source，Core
只把 keyed search document 同步進 AI Search；rebuild 的 durable 狀態、重試、
錯誤與 output 直接使用 Cloudflare Workflow。實體 Workflow 是
`newsence-search-index-rebuild`，class 是 `SearchIndexRebuildWorkflow`；
目前帶有 serving-index 版本的 runner 是 `search-index-rebuild-v6-native-v1`。

## 新增擷取 adapter

擷取 adapter 集中在 `ingest/platforms/*.ts`，只放它真正需要的
discovery / scrape / process 邏輯。App-owned saved URL 以 Workflow draft
進入 Core，成功處理後才建立 canonical row；upload 則先寫入 `resources`
與 `user_files`，再以 `resourceId` 啟動 Workflow。Core 在自己的
`resource-persistence.ts` transaction 寫入 canonical Resource、source 與 subject；
使用者的 save／container／file target 則由下一個 durable step 交給 Web。
Translation input query 與唯一 consumer 放在 `translation-workflow.ts`。

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
