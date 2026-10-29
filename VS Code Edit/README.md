# Kudu

Kudu is an on-premises industrial data platform foundation. This directory is the portable application: its frontend, backend, shared contracts, database setup, and documentation do not depend on Replit.

## Start locally

Prerequisites: Node.js 24 LTS and pnpm 10.26.1 via Corepack. For local development, use PostgreSQL 18 installed locally (Docker is optional). For production deployment, use Docker Compose as described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

On Windows, a guided no-Docker setup and launcher is available:

```powershell
.\scripts\kuduns.ps1 -Setup
.\scripts\kuduns.ps1 -Check
.\scripts\kuduns.ps1
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#windows-local-development-without-docker) for PostgreSQL setup, credentials, troubleshooting, and safe updates.

```sh
corepack enable
cp .env.example .env
docker compose up -d db
pnpm --filter @kudu/backend auth:hash-password
# Set the generated hash and a random SESSION_SECRET in .env.
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

Open the frontend at <http://localhost:5173>. The API listens at <http://localhost:3000>; health checks remain available at `GET /healthz` and `GET /api/v1/health`. Asset and data-source registry routes are documented in [docs/API.md](docs/API.md) and [docs/openapi.yaml](docs/openapi.yaml).

The password hash contains `$`; quote its value with single quotes in `.env`. For isolated loopback HTTP development only, set `KUDU_COOKIE_SECURE=false` if the browser does not accept Secure cookies.

For production, use the Docker Compose procedure in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). It builds the versioned production image, waits for PostgreSQL, applies migrations once, and starts the app only after migration succeeds. The same guide covers backup/restore and transferring images to offline hosts.

## Desktop shell

The Linux desktop shell and its current connection-mode limitations are documented in [docs/DESKTOP.md](docs/DESKTOP.md).

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
