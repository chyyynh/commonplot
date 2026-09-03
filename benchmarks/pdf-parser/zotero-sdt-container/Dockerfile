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

FROM docker.io/library/node:24-bookworm-slim

ENV DOCUMENT_WORKER_BUILD_DIR=/app/document-worker
ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY --from=builder /src/build /app/document-worker
COPY --from=builder /src/node_modules /app/node_modules
COPY server.cjs worker-thread.cjs /app/

USER node
EXPOSE 8080
CMD ["node", "/app/server.cjs"]
