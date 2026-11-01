# syntax=docker/dockerfile:1.7
ARG KUDU_VERSION=0.1.0

FROM node:24.22.1-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_USE_SYSTEM_CA=1 \
    npm_config_strict_ssl=true
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends --reinstall ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/validate-docker-ca.mjs ./scripts/validate-docker-ca.mjs
RUN corepack enable
RUN --mount=type=secret,id=corporate-ca,required=false \
    set -eu; \
    if [ -s /run/secrets/corporate-ca ]; then \
      node scripts/validate-docker-ca.mjs /run/secrets/corporate-ca; \
      export NODE_EXTRA_CA_CERTS=/run/secrets/corporate-ca; \
    fi; \
    corepack prepare pnpm@10.26.1 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
RUN --mount=type=secret,id=corporate-ca,required=false \
    set -eu; \
    if [ -s /run/secrets/corporate-ca ]; then \
      node scripts/validate-docker-ca.mjs /run/secrets/corporate-ca; \
      export NODE_EXTRA_CA_CERTS=/run/secrets/corporate-ca; \
    fi; \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM build AS production-dependencies
RUN --mount=type=secret,id=corporate-ca,required=false \
    set -eu; \
    if [ -s /run/secrets/corporate-ca ]; then \
      node scripts/validate-docker-ca.mjs /run/secrets/corporate-ca; \
      export NODE_EXTRA_CA_CERTS=/run/secrets/corporate-ca; \
    fi; \
    CI=true pnpm install --prod --filter @kudu/backend... --frozen-lockfile

FROM node:24.22.1-bookworm-slim AS runtime

ARG KUDU_VERSION
ENV NODE_ENV=production \
    NODE_USE_SYSTEM_CA=1
WORKDIR /app

LABEL org.opencontainers.image.title="Kudu" \
      org.opencontainers.image.version="${KUDU_VERSION}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends --reinstall ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist
COPY --from=build --chown=node:node /app/database/migrations ./database/migrations

RUN rm -rf backend/dist/test-support \
    && rm -f backend/dist/*.test.js backend/dist/auth-cli.js \
    && mkdir -p /var/lib/kudu \
    && chown node:node /var/lib/kudu

USER node
EXPOSE 3000 3001
CMD ["node", "backend/dist/index.js"]
