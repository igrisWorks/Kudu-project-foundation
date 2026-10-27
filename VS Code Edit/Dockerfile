FROM node:24-bookworm-slim

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

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "start"]
