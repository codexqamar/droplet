# syntax=docker/dockerfile:1.7
#
# DROPLET portal: one container serving the web portal and the cloud API on port 8080.
# PostgreSQL is external (Coolify database or the bundled docker-compose.yml).
# Migrations run automatically on start. Desktop installers live on the /data/releases volume.
#
#   docker build -t droplet .
#   docker run -p 8080:8080 --env-file .env.production -v droplet-releases:/data/releases droplet

ARG NODE_IMAGE=node:22-bookworm-slim

# ── base: OpenSSL for Prisma's query/schema engines ────────────────────────────
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# ── web portal (static build) ──────────────────────────────────────────────────
FROM base AS web
WORKDIR /build/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# ── cloud API (compiled TypeScript + generated Prisma client) ──────────────────
FROM base AS api
WORKDIR /build/api
COPY apps/cloud-api/package.json apps/cloud-api/package-lock.json ./
# --omit=optional skips the embedded dev-database binaries (development only).
RUN npm ci --omit=optional
COPY apps/cloud-api/ ./
RUN npx prisma generate \
 && npx tsc -p tsconfig.json \
 && npm prune --omit=dev --omit=optional

# ── runtime ────────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIST_DIR=/app/web \
    RELEASES_DIR=/data/releases
WORKDIR /app/api

COPY --from=api --chown=node:node /build/api/package.json ./package.json
COPY --from=api --chown=node:node /build/api/node_modules ./node_modules
COPY --from=api --chown=node:node /build/api/prisma ./prisma
COPY --from=api --chown=node:node /build/api/dist ./dist
COPY --from=web --chown=node:node /build/web/dist /app/web
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh

# Strip CRLF in case the file was checked out on Windows without .gitattributes.
RUN sed -i 's/\r$//' /app/entrypoint.sh \
 && chmod 0755 /app/entrypoint.sh \
 && mkdir -p /data/releases \
 && chown -R node:node /data

USER node
EXPOSE 8080
VOLUME ["/data/releases"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
