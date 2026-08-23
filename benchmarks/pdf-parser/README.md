# PDF parser envelope benchmark

This standalone Worker exercises the production LiteParse adapter without any application bindings, routes, secrets, storage, or provider calls. It exists only for the Phase 0 runtime gate in issue #287.

## Safety boundary

- Use public or synthetic PDFs only. Wrangler remote development creates a temporary public preview environment.
- The Worker returns hashes and aggregate parser metrics. It never returns, logs, or persists extracted document content.
- Requests require `Content-Type: application/pdf`, an exact positive `Content-Length`, a PDF signature, and at most 25 MiB.
- The runner permits only one or two concurrent requests so the benchmark cannot become a general load generator.

## Local runtime

Validate and bundle the isolated Worker:

```sh
pnpm check:pdf-benchmark
pnpm exec wrangler deploy --dry-run --config benchmarks/pdf-parser/wrangler.jsonc
```

Start a fresh local workerd process for each mode that will be compared:

```sh
pnpm exec wrangler dev --config benchmarks/pdf-parser/wrangler.jsonc --port 8799 --inspector-port 9230
```

Run whole-document or bounded-batch parsing:

```sh
node benchmarks/pdf-parser/run.mjs http://127.0.0.1:8799 /absolute/path/to/public.pdf 1 whole
node benchmarks/pdf-parser/run.mjs http://127.0.0.1:8799 /absolute/path/to/public.pdf 2 batch 10
```

Compare output semantics outside the Worker:

```sh
pnpm probe:pdf-artifact /absolute/path/to/public.pdf compare 10
```

Sample local V8 heap fields while recording the LiteParse WebAssembly linear-memory high-water mark:

```sh
node benchmarks/pdf-parser/memory.mjs \
  http://127.0.0.1:9230 \
  http://127.0.0.1:8799 \
  /absolute/path/to/public.pdf \
  1 whole
```

Restart Wrangler before each memory comparison. WebAssembly linear memory grows in place and does not shrink after a parse, so a reused isolate has a contaminated baseline.

## Interpretation

- `wasmMemoryBeforeBytes` and `wasmMemoryAfterBytes` are the exact size of LiteParse's exported linear-memory buffer at those points. The post-parse value is a retained high-water mark, not necessarily the instantaneous peak.
- The inspector probe records `Runtime.getHeapUsage` fields. Local workerd does not expose Chromium's `Memory` CDP domain, so these fields are V8 diagnostics, not total-isolate memory.
- Client wall time is useful for mode and concurrency comparisons but is not Worker CPU time.
- LiteParse documents that batch mode bounds Rust results and JS objects, but cross-page header/footer and image-deduplication passes see only their current batch. Compare hashes and page-level semantics; do not assume byte-identical output.
- Local success alone cannot clear the 128 MiB Workers memory gate. Before rollout, repeat the representative corpus in a production-equivalent remote environment and inspect deployed CPU, wall-time, memory, startup, and failure metrics.

Stop the rollout if any supported input approaches the 128 MiB isolate limit without comfortable headroom, exceeds the configured CPU envelope, produces an unacceptable semantic delta, or causes startup/bundle regression.
