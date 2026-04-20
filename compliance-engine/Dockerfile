# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.12

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /workspace

COPY package.json bun.lock tsconfig.base.json ./
COPY api/package.json api/package.json
COPY compliance-engine/package.json compliance-engine/package.json

RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim AS verify
WORKDIR /workspace

COPY package.json bun.lock tsconfig.base.json ./
COPY api/package.json api/package.json
COPY compliance-engine/package.json compliance-engine/package.json

RUN bun install --frozen-lockfile

COPY api api
COPY compliance-engine compliance-engine

RUN bun run engine:typecheck

FROM gcr.io/distroless/base-debian12:nonroot AS runtime
WORKDIR /app/compliance-engine

ENV NODE_ENV=production
ENV METRICS_PORT=9464

COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deps /workspace/node_modules /app/node_modules
COPY --from=deps /workspace/compliance-engine/node_modules /app/compliance-engine/node_modules
COPY --from=deps /workspace/package.json /app/package.json
COPY --from=deps /workspace/tsconfig.base.json /app/tsconfig.base.json
COPY compliance-engine /app/compliance-engine

EXPOSE 9464

ENTRYPOINT ["/usr/local/bin/bun", "src/index.ts"]
