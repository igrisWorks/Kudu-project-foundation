# Development

## Local Web Edition

Use Node.js 24 and pnpm 10.26.1. PostgreSQL, Docker, database credentials and
operator authentication are **not** required for Local.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm local:check
pnpm dev
```

Open `http://127.0.0.1:5173`. Use `pnpm dev -- --no-browser` to avoid opening a
browser. The frontend and backend bind to loopback; duplicate startup and occupied
ports are checked. Database initialization is automatic. Do not expose this
no-login development service through a LAN/public reverse proxy.

On Windows, `.\scripts\kuduns.ps1 -Setup`, `-Check` and the default daily launcher
now use the SQLite Local workflow. Existing `.env` and old PostgreSQL settings
are never overwritten or deleted.

See [LOCAL-SQLITE.md](LOCAL-SQLITE.md) for actual OS data locations, Desktop
differences, backups, recovery and explicit import of legacy PostgreSQL Local data.
The old database is not imported automatically.

## Authenticated Server/Enterprise development

PostgreSQL remains required for this separate edition. Copy `.env.example` to
`.env`, configure its PostgreSQL URL, generate an operator password hash with
`pnpm --filter @kudu/backend auth:hash-password`, and configure a random
`SESSION_SECRET` of at least 32 bytes. Quote `$`-containing hashes with single
quotes in `.env`. Never commit credentials.

```sh
pnpm db:migrate
pnpm dev:secure
```

For isolated loopback HTTP only, secure-edition development may use
`KUDU_COOKIE_SECURE=false`. Production still requires valid authentication,
secure cookies and HTTPS. Existing authenticated Windows setup helpers remain
behind the explicit `.\scripts\kuduns.ps1 -Server` switch.
See [DEPLOYMENT.md](DEPLOYMENT.md) for production PostgreSQL and Compose ordering.

## Quality checks

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @kudu/frontend test
node --test desktop/connection-policy.test.cjs desktop/local-runtime.test.cjs
```

Local SQLite tests create temporary databases and cover typed values, migrations,
restart persistence, registry APIs, precise timestamp filtering, event deduplication,
mapping lifecycle, JSON/CSV import, REST sync, backup/restore and damaged files.
Frontend DOM tests verify that status polling and failed restore preserve the
user's selected backup and confirmation.

PostgreSQL integration suites skip without `KUDU_TEST_DATABASE_URL`.
`local-postgres-import.integration.test.ts` separately uses
`KUDU_SQLITE_IMPORT_TEST_URL`; it creates schema, records and a read-only role.
**Both variables must target disposable databases, never production or an existing
user database.** Source import itself uses a read-only transaction.

## Conventions

Keep application changes inside `VS Code Edit/`. Keep Server PostgreSQL SQL in
`database/migrations/` and Local SQLite SQL in `database/sqlite-migrations/`.
Never alter an applied migration's contents/checksum; add a new ordered migration.
Preserve source validation, parameterized SQL, bounded file/REST processing and
environment references for external API secrets.

The Electron tools remain in the isolated `desktop/` package and lockfile. Do not
add Electron/Electron Builder dependencies to the root/server Docker workspace.
Build desktop resources with the root orchestration scripts; native SQLite
packaging must run on the target OS. See [DESKTOP.md](DESKTOP.md).
