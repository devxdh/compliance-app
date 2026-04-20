ARG BUN_VERSION=1.3.12

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app

COPY deploy/local/mock-gateway.ts /app/mock-gateway.ts

EXPOSE 8080

CMD ["bun", "run", "/app/mock-gateway.ts"]
