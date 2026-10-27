# Development

## Prerequisites

- Node.js 24 LTS.
- Corepack and pnpm 10.26.1 (`corepack enable`).
- Docker Engine with the Docker Compose plugin, or a local PostgreSQL 18 instance.
- Visual Studio Code is recommended but not required.

The environment variables are listed in `.env.example`. Never commit `.env`; use private environment configuration for real deployments.

## First run

From this directory:

```sh
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d db
pnpm db:migrate
pnpm dev
```

`pnpm dev` starts the API and Vite frontend. Vite serves `http://localhost:5173` and proxies API calls to `http://localhost:3000`. The status panel reads the live health endpoint; registry pages read and write persisted API records, not demonstration data.

## Quality checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm db:up` and `pnpm db:down` start and stop only the Compose database. `pnpm db:migrate` applies pending migrations and requires a reachable database. It also builds the shared package and backend first.

The default test command runs validation and existing unit tests. To run database migration and registry API integration tests against a disposable/local PostgreSQL database, set `KUDU_TEST_DATABASE_URL` and run `pnpm test`. The integration suite creates uniquely named records and removes them after the test; do not point it at production.

Event ingestion uses the same database integration-test connection. Focused checks can be run with:

```sh
cd backend
KUDU_TEST_DATABASE_URL=postgresql://... node --import tsx --test src/events.integration.test.ts
```

This test applies pending migrations and removes its unique fixture events, assets, and source afterward. It covers persisted payload/provenance, timestamp normalization, invalid references, source-scoped retries, and deduplication-key conflicts. Use a disposable or local database, never production.

## Conventions

- Keep runtime features in this directory, not in the Replit wrapper.
- Add shared request/response types in `shared/` and update `docs/API.md` alongside endpoint changes.
- Add migrations as new, ordered SQL files. Never edit an applied migration; add a later migration instead.
- Keep API route handlers thin. Put validation and domain/application decisions in backend services.
- Preserve original source timestamps and provenance when industrial data models are added.
- Use UTC for stored instants and parameterized SQL for all values.

## Debugging

- API logs are structured JSON; set `LOG_LEVEL=debug` for local detail.
- `GET /healthz` confirms process liveness.
- `GET /api/v1/health` also checks the database and returns `503` when it is unavailable.
- Check database readiness with `docker compose ps` and `docker compose logs db`.
- Stop the local frontend/API with Ctrl+C; stop the database with `pnpm db:down`.
