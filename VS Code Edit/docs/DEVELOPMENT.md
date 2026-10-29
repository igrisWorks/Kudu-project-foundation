# Development

## Prerequisites

- Node.js 24 LTS.
- Corepack and pnpm 10.26.1 (`corepack enable`).
- PostgreSQL 18 installed locally for database-backed use. The Local Web Edition can start without PostgreSQL so its Settings page remains available.
- Docker Engine with the Docker Compose plugin is optional for local development.
- Visual Studio Code is recommended but not required.

The secure-edition environment variables are listed in `.env.example`. Never commit `.env`; use private environment configuration for real deployments.

## Local Web Edition

The default `pnpm dev` command starts a local-only edition without operator sign-in. It needs no password hash, session secret, or `.env` file. It binds to `127.0.0.1`; the backend refuses local mode in production or on a non-loopback bind. Do not expose this edition to a network.

### Windows setup and startup

Install Node.js 24, PostgreSQL 18, and Corepack. PostgreSQL is optional for opening the UI but required for persisted data. From PowerShell at the project root:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173`. The launcher validates Node/pnpm versions, checks ports 3000 and 5173, prevents duplicate runs, and checks local PostgreSQL TCP reachability. On Windows, if it finds exactly one stopped service named `postgresql-x64-<version>`, it attempts `sc.exe start` for that service. If Windows denies permission, start it from Windows Services or run the command in an authorized PowerShell. It does not install PostgreSQL or alter service settings, and it does not start an ambiguous service. On Linux/macOS, start PostgreSQL manually.

If PostgreSQL is unavailable, Kudu starts in disconnected mode and shows the state on the dashboard and **Settings → Database**. The UI rechecks periodically, and only a real SQL query marks the database connected.

In **Settings → Database**, enter the loopback host (`127.0.0.1`, `::1`, or `localhost`), port, database, application username, and password if required. **Test connection** does not save. **Save connection** verifies the role, applies pending forward-only migrations, and switches the app to the connection. It never deletes or resets data.

To create missing PostgreSQL objects, expand **Initialize a missing database or application role**, enter administrator credentials, and authorize the operation. Kudu creates only the missing role/database. It does not alter an existing role password, and the administrator password is used only for that request. New roles require an application password of at least 12 UTF-8 bytes. If initialization partially succeeds and a later step fails, retry with the same names; the existing objects are preserved.

Database credentials stay in the backend. Windows saves them encrypted with DPAPI CurrentUser and a restricted ACL. Other operating systems use an owner-only JSON settings file (`0600`). This local-machine storage is not a managed secret vault; protect the operating-system account and disk. The file `.kudu-local-database.json` is ignored by Git, never returned through an API, and not stored in browser storage.

The launcher builds shared contracts, starts the backend and Vite, prints `http://127.0.0.1:5173`, and stops child processes on Ctrl+C. Use `pnpm dev -- --no-browser` or `KUDU_OPEN_BROWSER=0 pnpm dev` to suppress browser launch.

### Authenticated development edition

The secure edition remains available explicitly as `pnpm dev:secure`:

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm --filter @kudu/backend auth:hash-password
# Put the generated hash and a random SESSION_SECRET in .env.
pnpm db:migrate
pnpm dev:secure
```

Its Windows setup helper remains available:

```powershell
.\scripts\kuduns.ps1 -Setup
.\scripts\kuduns.ps1 -Check
.\scripts\kuduns.ps1 -SelfTest
.\scripts\kuduns.ps1
```

The helper provisions the authenticated edition, so it asks for operator authentication configuration. It is not required for the Local Web Edition.

The authenticated UI requires `KUDU_AUTH_PASSWORD_HASH` and `SESSION_SECRET`. Generate the hash interactively with `pnpm --filter @kudu/backend auth:hash-password`, then set both values in `.env` or the workspace Secrets panel. Do not commit either value. The example environment file intentionally leaves them blank; without them, private API routes fail closed while health probes continue to work.

## Quality checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm db:up` and `pnpm db:down` start and stop only the optional Compose database. `pnpm db:migrate` applies pending migrations and requires a reachable database. It also builds the shared package and backend first.

The default test command runs validation and existing unit tests. To run database migration and registry API integration tests against a disposable/local PostgreSQL database, set `KUDU_TEST_DATABASE_URL` and run `pnpm test`. The integration suite creates uniquely named records and removes them after the test; do not point it at production.

Event ingestion uses the same database integration-test connection. Focused checks can be run with:

```sh
cd backend
KUDU_TEST_DATABASE_URL=postgresql://... node --import tsx --test src/events.integration.test.ts
```

This test applies pending migrations and removes its unique fixture events, assets, and source afterward. It covers persisted payload/provenance, timestamp normalization, invalid references, source-scoped retries, and deduplication-key conflicts. Use a disposable or local database, never production.

File-import checks use the same disposable/local PostgreSQL connection:

```sh
cd backend
KUDU_TEST_DATABASE_URL=postgresql://... node --import tsx --test src/file-import.integration.test.ts
```

The focused tests cover CSV and JSON mapping, partial record failures, repeated imports, unsupported/disabled sources, path containment, malformed input, and size/count limits. Test files are created in temporary directories and removed afterward.

Versioned mapping checks use the same disposable/local database:

```sh
cd backend
KUDU_TEST_DATABASE_URL=postgresql://... node --import tsx --test src/event-mappings.integration.test.ts
```

The focused mapping tests cover CSV and JSON field selection, activation/version history, normalized records, preserved payload/provenance, validation failures, and unchanged imports when no mapping is active. The additive `0004_data_source_event_mappings.sql` migration is applied by the existing migration runner.

REST connector checks use a local mock HTTP server and the same disposable/local PostgreSQL connection:

```sh
cd backend
KUDU_TEST_DATABASE_URL=postgresql://... node --import tsx --test src/rest-sync.integration.test.ts
```

They cover REST configuration validation, persisted mapped records and duplicates, malformed JSON and remote HTTP failures, and blocked destinations and redirects. No live API is contacted.

Authentication checks are self-contained and use a fake database connection:

```sh
cd backend
node --import tsx --test src/auth.integration.test.ts
```

They verify public health checks, protected API reads/writes, password login, CSRF enforcement, logout, fail-closed configuration, and login throttling.

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
