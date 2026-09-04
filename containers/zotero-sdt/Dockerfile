FROM docker.io/library/node:24-bookworm-slim AS builder

ARG DOCUMENT_WORKER_COMMIT=021004463ff1f2d535c59ec21b08b2855e1c672f

RUN apt-get update
RUN apt-get install --yes --no-install-recommends ca-certificates git rsync
RUN corepack enable
RUN corepack prepare pnpm@11.9.0 --activate

WORKDIR /src
RUN git clone --filter=blob:none --no-checkout https://github.com/zotero/document-worker.git .
RUN git fetch --depth=1 origin ${DOCUMENT_WORKER_COMMIT}
RUN git checkout --detach ${DOCUMENT_WORKER_COMMIT}
RUN git submodule update --init --recursive --depth=1
RUN pnpm install --ignore-scripts
RUN pnpm exec webpack --mode production
RUN bash scripts/build-assets
RUN node scripts/build-metadata.js
RUN node scripts/build-structured-document-text.js

# The production bundles inline document-worker's JavaScript dependencies. The
# only runtime package left external is the Node canvas implementation used by
# PDF.js and source-crop rendering. Assemble that exact package and its pinned
# native binding from the lockfile-backed builder install instead of copying the
# complete build toolchain into the runtime image.
RUN node --eval "const { cpSync, mkdirSync } = require('node:fs'); const { dirname, join } = require('node:path'); if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Zotero SDT runtime must be assembled for linux/amd64'); const canvasManifest = require.resolve('@napi-rs/canvas/package.json'); const nativeName = '@napi-rs/canvas-linux-x64-gnu'; const nativeManifest = require.resolve(nativeName + '/package.json', { paths: [canvasManifest] }); const target = '/runtime-node-modules/@napi-rs'; mkdirSync(target, { recursive: true }); cpSync(dirname(canvasManifest), join(target, 'canvas'), { recursive: true }); cpSync(dirname(nativeManifest), join(target, 'canvas-linux-x64-gnu'), { recursive: true });"

FROM docker.io/library/node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/zotero/document-worker"
LABEL org.opencontainers.image.revision="021004463ff1f2d535c59ec21b08b2855e1c672f"
LABEL org.opencontainers.image.licenses="AGPL-3.0"

ENV DOCUMENT_WORKER_BUILD_DIR=/app/document-worker
ENV MAX_DOCUMENT_BYTES=33554432
ENV NODE_PATH=/app/node_modules
ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY --from=builder /src/build /app/document-worker
COPY --from=builder /runtime-node-modules /app/node_modules
COPY --from=builder /src/COPYING /usr/share/licenses/zotero-document-worker/COPYING
COPY server.cjs worker-thread.cjs /app/
COPY canvas-compat /app/node_modules/canvas

# document-worker dynamically imports the node-canvas package name for source
# crops. Reuse its existing @napi-rs/canvas runtime through the small adapter
# above, including the registerFont API needed to render PDF text.
RUN node --input-type=module --eval "const canvas = await import('canvas'); if (typeof canvas.registerFont !== 'function') throw new Error('Canvas font registration unavailable'); const surface = canvas.createCanvas(1, 1); if (!surface.getContext('2d')) throw new Error('Canvas runtime unavailable')"

USER node
EXPOSE 8080
CMD ["node", "/app/server.cjs"]
