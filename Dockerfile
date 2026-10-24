FROM cloudflare/cloudflared:2026.10.1@sha256:a15a3b50b8dabd57ac2090e9484c0247dba9dfa1f0df4d298d4317f9d69eb2d5 AS cloudflared
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.web.json ./
COPY scripts/patch-playwright.mjs ./scripts/patch-playwright.mjs
COPY src/user-agent.js ./src/user-agent.js
RUN npm ci
COPY src ./src
COPY web ./web
COPY docs/assets ./docs/assets
COPY scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production DATA_DIR=/data MCP_SOCKET=/tmp/browser-mcp/service.sock WEB_PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser package.json README.md ./
COPY --chown=pwuser:pwuser docs ./docs
RUN mkdir -p /data /config /tmp/browser-mcp && chown -R pwuser:pwuser /data /config /tmp/browser-mcp
USER pwuser
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "dist/cli.js", "health"]
CMD ["node", "dist/cli.js", "daemon"]
