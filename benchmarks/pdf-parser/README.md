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

The spike intentionally does not:

- replace LiteParse Markdown or the GROBID/Crossref citation workflow;
- add `document-worker` as a production dependency;
- persist SDT or PDF source coordinates;
- change the Cloudflare deployment.

Promoting it to production requires a deliberate AGPL distribution decision and a runtime choice. The browser-oriented Worker plus model assets are small enough to investigate in a dedicated service, but compatibility with Workers and Containers must be measured rather than inferred from the Node spike.
