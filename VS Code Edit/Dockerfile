ARG KUDU_VERSION=0.1.0

FROM node:24.22.1-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM build AS production-dependencies
RUN CI=true pnpm install --prod --filter @kudu/backend... --frozen-lockfile

FROM node:24.22.1-bookworm-slim AS runtime

ARG KUDU_VERSION
ENV NODE_ENV=production
WORKDIR /app

LABEL org.opencontainers.image.title="Kudu" \
      org.opencontainers.image.version="${KUDU_VERSION}"

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
