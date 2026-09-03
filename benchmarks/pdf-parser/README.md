# PDF parser spikes

These benchmarks are additive experiments. They do not participate in the production PDF ingestion workflow.

## Zotero Structured Document Text

`zotero-sdt-spike.mjs` runs Zotero's AGPL-3.0 `document-worker` against a local PDF and reports the semantic blocks, bibliography links, source-coordinate coverage, output size, and timing. It deliberately consumes an external checkout instead of copying AGPL source into Newsence while the integration is still being evaluated.

Pin the evaluated upstream revision and build it with pnpm:

```sh
git clone --recursive https://github.com/zotero/document-worker.git /private/tmp/zotero-document-worker
git -C /private/tmp/zotero-document-worker checkout 021004463ff1f2d535c59ec21b08b2855e1c672f
pnpm -C /private/tmp/zotero-document-worker install
pnpm -C /private/tmp/zotero-document-worker run build
```

Run the report from `workers/core-worker`:

```sh
pnpm spike:zotero-sdt -- \
  --document-worker /private/tmp/zotero-document-worker \
  --pdf /absolute/path/to/paper.pdf \
  --runs 2 \
  --output /private/tmp/zotero-sdt-report.json
```

The default report contains only summary metrics and small samples. Add `--include-document` when the complete materialized SDT is needed for renderer prototyping. Do not persist that debug output for private uploads.

Baseline on the pinned checkout's `advancing-mathematics-by-guiding-human-intuition-with-ai.pdf` fixture (10 pages, 2.4 MB) on an Apple Silicon development machine:

- 1.14 seconds on the first parse and 0.52 seconds on the second parse in the same process;
- 49 bibliography entries, 60 bibliography citation markers, and 68 marker-to-reference links;
- all 60 citation markers have a `textMap`, and all 1,171 decoded text maps exactly match their non-whitespace source-character counts;
- 116 KB packed SDT (5% of the PDF) and 442 KB when materialized as JSON.

These timings are a local comparison point, not a Cloudflare latency claim. The mapping checks prove that the parser emitted the source geometry required by Zotero's PDF/Reading Mode annotation bridge; they do not yet exercise the Reader's rectangle-merging UI code.

The spike intentionally does not:

- replace LiteParse Markdown or the GROBID/Crossref citation workflow;
- add `document-worker` as a production dependency;
- persist SDT or PDF source coordinates;
- change the Cloudflare deployment.

Promoting it to production requires a deliberate AGPL distribution decision and a runtime choice. The browser-oriented Worker plus model assets are small enough to investigate in a dedicated service, but compatibility with Workers and Containers must be measured rather than inferred from the Node spike.

### Isolated Cloudflare Container prototype

`zotero-sdt-container/` packages the same parser behind a streaming Worker facade and a small Node HTTP service. The Worker has no public `workers.dev` or preview URL, uses one `basic` instance, and sleeps after two idle minutes. It remains disconnected from Core's production workflow.

For a quick local service check using an already-built checkout:

```sh
DOCUMENT_WORKER_BUILD_DIR=/private/tmp/zotero-document-worker/build \
  pnpm spike:zotero-sdt:container

curl --fail-with-body \
  --header 'Content-Type: application/pdf' \
  --data-binary @/absolute/path/to/paper.pdf \
  --output /private/tmp/zotero-sdt.pack \
  http://127.0.0.1:8080/parse
```

The response is the compact `application/vnd.zotero.sdt-pack` payload. Parse time, process RSS, and source MD5 are returned in `x-newsence-*` headers. The same 25 MB request guard used by Core's production PDF pipeline is enforced by both the Worker (when `Content-Length` is available) and the container while streaming the request body.

Validate the isolated Wrangler contract without building or deploying the image:

```sh
pnpm spike:zotero-sdt:check
```

Build the pinned `linux/amd64` image from `zotero-sdt-container/` when Docker is available. The runtime currently keeps the upstream pnpm dependencies so `@napi-rs/canvas` can supply PDF.js geometry primitives; optimize those layers only after the functional image is measured.

The first local `linux/amd64` build is 179,235,185 bytes uncompressed. Under amd64 emulation on Apple Silicon, the 15-page Newsence sample used about 740-763 MiB RSS (3.96 seconds cold, 1.73 seconds warm), while Zotero's 54-page raster-text fixture reached about 802 MiB RSS in 3.42 seconds. This rules out the 256 MiB `lite` instance. The configured 1 GiB `basic` instance is suitable for continued spike testing because requests are serialized, but its remaining memory margin must be observed on a broader corpus before production adoption.
