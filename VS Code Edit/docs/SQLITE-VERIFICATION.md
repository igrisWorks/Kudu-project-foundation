# Embedded SQLite verification

## Implementation

Authoritative source: `VS Code Edit/`. Local uses `better-sqlite3` 13.0.3,
Kysely SQLite and SQLite 3.53.4 on the tested Linux Node runtime. This version
uses N-API so the intended bundled Node/Electron integration does not need an
Electron-specific ABI rebuild. It **does** compile during installation: native
build prerequisites are required on build/developer machines. Docker build
stages install Python/make/g++ and use the official image's matching Node headers;
the final runtime image does not contain those compiler tools.

Principal changed/new paths:

- `backend/src/sqlite-database.ts`, `database/sqlite-migrations/`: SQLite
  initialization, adaptation, migration history/checksums and integrity.
- `backend/src/local-database.ts`, `local-database-routes.ts`: status, online
  backups, schema-compatible confirmed restore and write draining.
- `backend/src/database.ts`, `registry.ts`, `events.ts`, `event-mappings.ts`:
  dialect-aware persistence while retaining the PostgreSQL factory and locks.
- `backend/src/config.ts`, `index.ts`, `app.ts`: explicit Local startup,
  loopback/runtime guards, API readiness and safe SQLite errors.
- `backend/src/import-postgres-local.ts`: explicit read-only legacy import.
- `frontend/src/api.ts`, `App.tsx`, `pages/SettingsPage.tsx`,
  `pages/HomePage.tsx`, `pages/DesktopConnectionPage.tsx`,
  `desktop-bridge.d.ts`: SQLite UI and managed Local launch.
- `desktop/main.cjs`, `preload.cjs`, `local-preload.cjs`, `local-runtime.cjs`,
  `electron-builder.json`, `package.json`: owned backend and packaged resources.
- `scripts/dev.mjs`, `kuduns.ps1`, `kuduns-local.ps1`, `check-local.mjs`,
  `prepare-desktop-local.mjs`, `docker-local.mjs`: entrypoints and packaging.
- `Dockerfile`, `docker-compose.local.yml`, `.dockerignore`, ignore files,
  package manifests/workspace approval/lockfile: native dependency and persistence.
- Local/SQLite/backend/UI/runtime tests, README, `.env.example` and Local guides.

PostgreSQL SQL migration files and secure `docker-compose.yml` were not changed.
The PostgreSQL factory now sets its existing application search path explicitly;
the disposable PostgreSQL test verified the revised event insert/deduplication
path against PostgreSQL, not just a SQL mock.

## Checks performed

1. `pnpm build` (also run by desktop packaging): shared/backend TypeScript,
   frontend TypeScript and Vite production output passed.
2. `pnpm local:check`: native driver, temporary database migrations, integrity
   and clean close passed.
3. `pnpm --filter @kudu/backend test`: Local API/auth/validation/config and
   SQLite tests passed after updating obsolete PostgreSQL-Settings assertions.
   Two PostgreSQL registry/migration tests skipped without
   `KUDU_TEST_DATABASE_URL`; these skips are **not** counted as passes.
4. Targeted `src/config.test.ts` and `src/local-docker-proxy.test.ts`: explicit
   Desktop Local flag, ignored legacy URL, forbidden mixed editions, loopback
   proxy forwarding and hostile Host rejection passed.
5. SQLite tests exercised fresh initialization, typed JSON/boolean/date data,
   hierarchy and duplicate rejection, microsecond ordering/filtering, event
   idempotency, JSON and CSV mapping/import, REST sync, reopening persistence,
   hierarchy restore, active-write drain, incompatible backup rejection, changed
   migration checksum rejection, inaccessible directory and corruption byte
   preservation. No automatic reset/deletion recovery is implemented.
6. `pnpm --filter @kudu/frontend test`: polling and failed restore preserve
   selected backup/confirmation; successful restore updates confirmed state.
7. `node --test desktop/connection-policy.test.cjs desktop/local-runtime.test.cjs
   scripts/*.test.mjs`: 12 checks passed for navigation/HTTP acknowledgment,
   sandbox policy, Local process configuration, Docker port safety and CA validation.
8. A uniquely named PostgreSQL 18.6 container with temporary storage was created
   only for `local-postgres-import.integration.test.ts`. A SELECT-only role with
   read-only transactions successfully imported IDs, hierarchy, JSON, mappings
   and precise timestamps. Nonempty destination import was refused. Source
   records remained present. The diagnostic container was removed afterward.
9. `docker compose -f docker-compose.local.yml config --quiet` passed.
   Secure Compose initially refused its missing required `POSTGRES_PASSWORD`;
   subsequent `config --quiet` validation passed with an empty environment file
   and diagnostic-only placeholder values. Production credentials were not
   supplied or read.
10. A new diagnostic Docker image built successfully after the first build
    independently exposed the missing C++/Python toolchain required by the addon.
    TLS validation/CA-secret handling remained enabled.
11. A uniquely named, nonroot/read-only Docker diagnostic instance with a new
    temporary data directory and **127.0.0.1-only published port** passed actual
    HTTP SQLite readiness, Settings, asset creation, container restart and full
    container recreation with the same temporary directory. Data persisted and
    the database mode was `0600`. Only the diagnostic containers/directory were
    removed; existing user database containers and volumes were untouched.
12. `pnpm desktop:package:appimage` passed and produced
    `release/desktop/KuduNS-0.1.0.AppImage`, with production frontend/backend,
    SQLite migrations and the native addon dependency tree in extra resources.

## Explicit runtime/platform limitations

- The Docker diagnostic container's health result was **unhealthy** because
  Docker could not execute the health-check process:
  `OCI runtime exec failed: exec failed: unable to start container process:
  error executing setns process: exit status 1: unknown`.
  Independently, HTTP `/api/v1/health` returned database `connected` and real
  write/restart/recreation checks passed. This is evidence of an exec/runtime
  limitation, not a reason to remove the health check. Healthy Docker exec must
  still be verified on the deployment host.
- Packaged Electron execution was **not verified**: direct launch lacked
  `libglib-2.0.so.0`; using available Nix libraries encountered an incompatible
  libc ABI, then a missing transitive desktop library. No sandbox disabling or
  application security workaround was applied. A package build is not a GUI run
  or proof that Electron loaded the native addon.
- No Windows OS is available here. Windows NSIS build, clean-PC installation,
  Electron userData path, native loading, actual utility-process IPC, Desktop
  folder reveal and persistence after Desktop restart remain **NOT VERIFIED**.
  The build must run on Windows with Python/Visual Studio C++ build tools; the
  resulting installer should then be tested on a separate clean IPC without them.
- Frontend input reliability was exercised with DOM tests. A local headless
  Chromium capture additionally verified the built standalone Settings page,
  SQLite Ready state, path/schema/integrity display and recovery controls. The
  temporary backend remained loopback-only and was shut down afterward. This
  does not verify Electron GUI/IPC or expose Local through a remote preview.
- Real power-loss/forced-kill durability, long-running industrial workload and
  multi-day connector stability were not established by these short tests.

## Run and release gate

Use [LOCAL-SQLITE.md](LOCAL-SQLITE.md) for paths, migration and clean-IPC steps.
Local has no PostgreSQL service/database-role/password prerequisite. Existing
PostgreSQL Local data is retained but requires explicit migration before relying
on the new Local store.

Treat clean Windows installation/runtime acceptance and healthy Docker exec on
the target host as outstanding release checks. Do not claim full industrial
production readiness based only on the successful builds or backend tests.
