# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.12

FROM oven/bun:${BUN_VERSION}-slim AS verify
WORKDIR /workspace

COPY package.json bun.lock tsconfig.base.json ./
COPY api/package.json api/package.json
COPY compliance-engine/package.json compliance-engine/package.json
COPY web/package.json web/package.json

RUN bun install --frozen-lockfile

COPY web web

RUN bun run web:typecheck
RUN bun run web:build

FROM gcr.io/distroless/base-debian12:nonroot AS runtime
WORKDIR /app/web

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=verify /usr/local/bin/bun /usr/local/bin/bun
COPY --from=verify /workspace/node_modules /app/node_modules
COPY --from=verify /workspace/web/node_modules /app/web/node_modules
COPY --from=verify /workspace/web/.next /app/web/.next
COPY --from=verify /workspace/web/package.json /app/web/package.json
COPY --from=verify /workspace/web/next.config.ts /app/web/next.config.ts
COPY --from=verify /workspace/web/public /app/web/public

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/bun", "run", "start"]
