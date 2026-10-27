# Kudu

Kudu is an on-premises industrial data platform foundation. This directory is the portable application: its frontend, backend, shared contracts, database setup, and documentation do not depend on Replit.

## Start locally

Prerequisites: Node.js 24 LTS, pnpm 10.26.1 via Corepack, Docker Compose, and PostgreSQL 18 for the supported deployment setup.

```sh
corepack enable
cp .env.example .env
docker compose up -d db
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

Open the frontend at <http://localhost:5173>. The API listens at <http://localhost:3000>; health checks remain available at `GET /healthz` and `GET /api/v1/health`. Asset and data-source registry routes are documented in [docs/API.md](docs/API.md) and [docs/openapi.yaml](docs/openapi.yaml).

For a production-style local run, use `pnpm build`, then `pnpm start`. Docker Compose builds and runs the web application and database together; set a private `POSTGRES_PASSWORD` in `.env` first.

## Project map

- `frontend/` — React and Vite UI.
- `backend/` — Fastify API, Kysely database access, and SQL migration runner.
- `shared/` — shared TypeScript API contracts.
- `database/migrations/` — ordered, checksummed PostgreSQL migrations.
- `database/seed/` — reserved for deliberate, repeatable development seed data.
- `docs/` — architecture, local development, deployment, API, data model, and change history.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Development](docs/DEVELOPMENT.md)
- [Deployment](docs/DEPLOYMENT.md)
- [API](docs/API.md)
- [Data model](docs/DATA_MODEL.md)
- [Changelog](docs/CHANGELOG.md)

The MVP includes persistent asset and data-source registries, event ingestion, mapped file import, read-only REST sync, and single-operator authentication. It does not include PLC control, per-user roles, or multi-user account management. Registry, event, import, mapping, and sync API routes require the configured operator session and CSRF token; keep the application bound to loopback and use TLS for remote access.
