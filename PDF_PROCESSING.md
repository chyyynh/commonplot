# PDF processing and recovery

Core uses the pinned Zotero document-worker for structured text and source-region rendering. Uploaded and fetched PDFs share `parseStoredPdfRepresentation`; Web only projects persisted renditions and authorizes their media.

## Quality and retries

`structuredPdfVisualPlan` selects semantic figures/tables and conservative caption-bounded regions. It retains author text while excluding repeated first-page affiliation blocks misclassified as tables. The 64-crop budget and unavailable/ambiguous geometry produce explicit missing-region outcomes. Inferred regions remain marked `caption-region-inferred`; usable text does not imply proven visual completeness. No inferred region automatically authorizes a paid OCR provider.

Each source has:

- `<pdfStorageKey>.structured-document.json`: structured text, admitted by input SHA-256 and the parser artifact revision.
- `<pdfStorageKey>.structured-crops/<inputSha256>/manifest.json`: planned/ready crop IDs and failures, including whether they are retryable.
- The same crop directory's `quality.json`: the completed text/visual quality summary.
- Immutable `<cropId>.png` images. IDs include the pinned build, schema/processor version, crop recipe, page, and rectangle.

The renderer receives one PDF per batch of at most eight regions. It streams bounded PNG rows; Core stores each result independently. An incomplete batch persists its manifest and fails the acquisition checkpoint. Workflow retries retain the structured document and successful PNGs and render only missing crops. Permanent input failures stop retries; transport, capacity, and server errors remain retryable. Container queue wait expiry rejects only that waiting request; the active processing watchdog starts after admission.

When changing the document-worker build or crop algorithm, update the explicit artifact/recipe versions in `zotero-sdt.ts` alongside the pinned Docker build as applicable. Do not overwrite old crop objects: stored content may still reference their immutable URLs. Existing private crop URLs without a digest remain readable.

## Source ownership

Uploaded PDF content and translations stay on its private raw Resource. If paper identification also produces a corpus Resource, Core removes private crop image references from the shared body. The owner's reader and authorized Knowledge reads project the attached raw rendition; anonymous/public reads use corpus content. Deleting the upload removes that raw rendition and its crop family, so owner reads fall back to the independent corpus version. Private media authorization is unchanged.

Public URL acquisition writes a separate `public-pdf/<sourceSha256>/<inputSha256>/` family. Matching bytes in a private upload never establish public provenance. Only after canonical persistence does Core validate the source and complete crop manifest and write `publication.json`. Public crop delivery requires that publication, an enriched corpus Resource, and the exact crop URL in its current original content. Raw public acquisition artifacts have no public download route. Public crop storage is independent of user upload deletion.

Existing corpus bodies with private image references are cleaned when explicitly reprocessed, including references in preserved human translations. Human text remains intact; obsolete alignment and citation offsets are cleared. This is an ingestion repair, not a mutation performed by reads.

## Operator verification

Run `pnpm lint`, `pnpm run typecheck`, and `pnpm check:pdf` from this workspace. The PDF suite covers geometry and metadata classification, partial storage failures and replay, versioned cache reuse, source isolation, media rendition behavior, bounded batching, and queue expiry. Container HTTP tests bind localhost. Web checks and its media/Knowledge/upload lifecycle tests cover authorization and deletion.

Deploy the Web media/reading changes and the Core Worker **with its updated Zotero container image** before admitting new processing. A Worker-only deployment with `--containers-rollout=none` cannot activate the new batch endpoint.

After deployment, reprocess an uploaded PDF using the existing service RPC `enqueueResourceProcessing({ resourceId: <raw-file-resource-id>, retry: true })`; do not pass its canonical paper ID. Use `resyncResource` for a resource with an external URL. Inspect Workflow status, the crop/quality manifests, canonical/private translations, and owner/non-owner reads. A completed canonical row alone does not prove all follow-ups succeeded. No production backfill is implicit in a code deployment.

The Cocoa regression was checked against the user-supplied 23-page PDF: the new plan has 10 figures and 4 genuine tables; 19 affiliation crops are excluded. All 14 regions rendered with the pinned Zotero runtime, and all five recovered figures were visually inspected. The full copyrighted PDF is not committed as a fixture.
