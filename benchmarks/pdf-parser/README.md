# PDF parser spikes

These benchmarks preserve the evidence used to select the production PDF parser.

## Zotero Structured Document Text

`zotero-sdt-spike.mjs` runs Zotero's AGPL-3.0 `document-worker` against a local PDF and reports the semantic blocks, bibliography links, source-coordinate coverage, output size, and timing. It consumes an external checkout so the benchmark can test arbitrary upstream revisions independently of the pinned production image.

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

The production implementation lives in `containers/zotero-sdt/` and pins the
evaluated upstream revision in its Dockerfile. Core materializes bounded SDT JSON,
uses it as the sole source for Reader Markdown and citation relationships, and
stores private-upload geometry in a content-hash-guarded R2 sidecar. GROBID remains
only for header classification and Crossref remains the metadata resolver.

The first local `linux/amd64` build is 179,235,185 bytes uncompressed. Under amd64
emulation on Apple Silicon, the 15-page Newsence sample used about 746 MiB RSS and
3.77 seconds to parse plus 30 ms to materialize; it yielded 139 bibliography
entries, 156 citation markers, and 204 marker-to-reference links. This rules out
the 256 MiB `lite` instance and supports the configured 1 GiB `basic` instance.
