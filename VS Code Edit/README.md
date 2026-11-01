# Kudu

Kudu is an on-premises industrial data platform foundation. This directory is the portable application: its frontend, backend, shared contracts, database setup, and documentation do not depend on Replit.

## Start locally

Prerequisites: Node.js 24 LTS and pnpm 10.26.1 via Corepack. For local development, use PostgreSQL 18 installed locally (Docker is optional). For production deployment, use Docker Compose as described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

The default `pnpm dev` command runs the explicit, loopback-only Local Web Edition without operator sign-in. It does not need `KUDU_AUTH_PASSWORD_HASH` or `SESSION_SECRET`:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173>. Configure or provision a local PostgreSQL connection at **Settings → Database**. The launcher checks Node/pnpm versions, local database reachability, ports, and duplicate instances; on Windows it attempts to start one matching stopped PostgreSQL service when permitted. Use `pnpm dev -- --no-browser` to suppress the browser. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#local-web-edition) for exact setup steps, credential storage, OS limitations, and troubleshooting.

The original authenticated development edition remains available explicitly as `pnpm dev:secure`. On Windows, `.\scripts\kuduns.ps1 -Setup` is the guided secure-edition setup.

```sh
corepack enable
cp .env.example .env
docker compose up -d db
pnpm --filter @kudu/backend auth:hash-password
# Set the generated hash and a random SESSION_SECRET in .env.
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev:secure
```

The authenticated frontend is at <http://127.0.0.1:5173>; the API listens at <http://127.0.0.1:3000>. Health checks remain available at `GET /healthz` and `GET /api/v1/health`. Asset and data-source registry routes are documented in [docs/API.md](docs/API.md) and [docs/openapi.yaml](docs/openapi.yaml).

The password hash contains `$`; quote its value with single quotes in `.env`. For isolated loopback HTTP secure-edition development only, set `KUDU_COOKIE_SECURE=false` if the browser does not accept Secure cookies. `KUDU_LOCAL_MODE` is set automatically by `pnpm dev` and is never accepted in production or with a non-loopback host.

For production, use the Docker Compose procedure in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). It builds the versioned production image, waits for PostgreSQL, applies migrations once, and starts the app only after migration succeeds. The same guide covers backup/restore and transferring images to offline hosts. For the no-login local edition in Docker, run `pnpm docker:local` and follow [docs/LOCAL-DOCKER.md](docs/LOCAL-DOCKER.md); it uses a separate Compose file, a loopback-only published port, and an optional BuildKit-only CA secret.

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

The MVP includes persistent asset and data-source registries, event ingestion, mapped file import, read-only REST sync, a local no-login development edition, and the original single-operator authenticated edition. It does not include PLC control, per-user roles, or multi-user account management. The secure edition's registry, event, import, mapping, and sync API routes require the configured operator session and CSRF token; keep remote access behind HTTPS.
