# KuduNS Local: embedded SQLite

## Current architecture

`VS Code Edit/` is the authoritative portable application. Local Web and Desktop
now use `better-sqlite3` through Kysely's SQLite dialect. PostgreSQL remains the
Server/Enterprise database and is used only by the explicit legacy import tool.
It is not a Local startup dependency.

Local initialization creates directories, opens `kuduns.db`, enables foreign
keys, WAL, a 5-second busy timeout and FULL synchronous durability, applies
checksummed migrations in order, and checks integrity and foreign keys before
the backend becomes ready. Migration failures do not trigger database deletion.
SQLite uses its own `database/sqlite-migrations/`; PostgreSQL migrations remain
separate and unchanged.

SQLite values are adapted at the persistence boundary: JSON remains JSON at the
API, booleans remain booleans, dates retain the existing API representation, and
event timestamps are normalized to UTC with six fractional digits for sorting
and filtering. SQLite write transactions replace PostgreSQL-only locking where
needed. Server transactions retain PostgreSQL row/advisory locks.

## Run on a clean industrial PC without PostgreSQL or Docker

### Local Web from source

For a source/developer checkout, install Node.js 24 and pnpm 10.26.1 plus native
build prerequisites (Python 3 and C++ build tools: Visual Studio Build Tools with
Desktop C++ on Windows, Xcode command-line tools on macOS, or make/g++ on Linux).
The chosen SQLite addon compiles during dependency installation. End-user IPCs
should use the bundled installer below and do not need these build tools.
Then run from `VS Code Edit/`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm local:check
pnpm dev
```

Open `http://127.0.0.1:5173`. No `.env`, database user, password, administrator
account, database server or operator login is required. `pnpm local:check` checks
the native SQLite module and migrations in a temporary directory, not user data.
Use `pnpm dev -- --no-browser` to suppress automatic browser opening.

Windows PowerShell offers the same Local path:

```powershell
.\scripts\kuduns.ps1 -Setup
.\scripts\kuduns.ps1 -Check
.\scripts\kuduns.ps1
```

The default launcher no longer searches for, installs, starts or provisions
PostgreSQL. The older authenticated setup is available only via the explicit
`-Server` switch; `pnpm dev:secure` remains the normal Server development path.

### Desktop installers

Build on the target operating system with its native build prerequisites because
the SQLite native binary is platform-specific:

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
# Windows host:
pnpm desktop:package:win
# Linux host:
pnpm desktop:package:appimage
```

Install/run the result and choose **Start KuduNS Local**. The installer contains
Electron, the frontend, backend, native SQLite module and migrations. The target
IPC does not need Node.js, pnpm, PostgreSQL or Docker. Windows installers are
unsigned unless release signing is configured separately. Do not treat a Linux
packaging success as proof that a Windows installer has run successfully.

The main process owns an Electron utility-process backend on an ephemeral
`127.0.0.1` port. It waits for database readiness before opening the window and
stops its owned process on exit. Local windows retain sandboxing and context
isolation; only the Local window receives the restricted reveal-folder bridge.
Remote Server windows keep the existing authenticated connection flow.

## Data locations and permissions

Standalone Node:

| OS | Default directory |
|---|---|
| Windows | `%LOCALAPPDATA%\KuduNS` |
| macOS | `~/Library/Application Support/KuduNS` |
| Linux | `$XDG_DATA_HOME/KuduNS`, otherwise `~/.local/share/KuduNS` |

Desktop passes Electron's actual `app.getPath("userData")` directory. Its OS
default can differ from the standalone Node directory. Settings shows the exact
path. An absolute `KUDU_DATA_DIR` override is available for managed installations.
The file is `kuduns.db`; backups are in `backups/`. Desktop diagnostics append to
`local-runtime.log` in its user-data directory.

POSIX app directories are mode `0700`; database and backup files are mode `0600`.
Windows uses the user's profile directory and OS ACLs, not Linux permission
assumptions. There is no database credential or DPAPI subprocess in SQLite Local.
External REST authentication is unchanged: source configuration stores an
environment credential reference, not the bearer token. Configure that secret
separately in the process environment.

## Backups and restore

Settings provides status, database location, schema/SQLite versions, startup
integrity result, last initialization, folder-path copying, Desktop folder reveal,
backup creation and explicit confirmed restore. Refresh only updates status and
backup choices; it never resets the user's selection or confirmation after a
failure.

Backups use SQLite's online backup API and are integrity-checked. Never copy only
a live `kuduns.db` while WAL writes are active. Existing backups are not pruned.
Copy completed backup files to a separate device for disaster recovery.

Restore blocks new writes, drains in-flight imports/synchronizations, validates
the selected regular backup file and migration checksums, creates a safety backup,
and replaces application data in one deferred-foreign-key transaction. Integrity
is checked before commit. Failure rolls the transaction back; it does not restore
an older snapshot over intervening writes. Concurrent restore is rejected.
Currently restore requires the same schema/checksums as the running application.
For an older backup, keep the original, open a **copy** with the matching application
version, upgrade that copy through migrations, and then restore its compatible
backup. Unknown/newer schema backups are rejected before modifying current data.

If startup detects corruption or inaccessible storage, it stops rather than
resetting the file. Preserve the database, WAL/SHM sidecars and backups. For
recovery without overwriting the damaged original, start with a new absolute
`KUDU_DATA_DIR`, place a verified compatible backup in its `backups/` folder, and
restore through Settings. Investigate disk and permissions before returning to
normal operation.

## Explicit migration from old PostgreSQL Local

**Existing PostgreSQL data is not automatically imported or deleted.** Stop Local
before migrating. Preserve a PostgreSQL backup and any old settings file.
Choose the intended SQLite data directory (Desktop and Web defaults can differ).
The destination must be empty; the importer refuses to merge/overwrite data.

Set these privately in the terminal environment:

- `KUDU_LEGACY_DATABASE_URL`: the old database's PostgreSQL URL, preferably using a
  role with only schema USAGE and table SELECT privileges.
- `KUDU_DATA_DIR`: absolute destination directory.
- `KUDU_CONFIRM_LOCAL_IMPORT=YES`: explicit authorization.

Then run:

```sh
pnpm local:import-postgres
```

The tool reads `kudu.assets`, `kudu.data_sources`, `kudu.events` and
`kudu.data_source_event_mappings` in a read-only repeatable-read snapshot, in
bounded batches. One destination transaction preserves IDs, hierarchy, mappings,
JSON, statuses and timestamps, and validates integrity/FKs. It prints counts and
the destination path, never the source URL or password. Failed inserts roll back.
Rerunning a completed import is refused because the destination is nonempty.

No source schema migration, role provisioning, credential changes, database drop
or Docker volume deletion occurs. Legacy `.kudu-local-database.json`,
Docker `settings.json`, PostgreSQL databases and PostgreSQL volumes are retained.
Unknown source columns fail explicitly rather than being silently discarded.

## Security and remaining connector scope

Local is a single-machine no-login application. Host binding, Host/Origin checks
and Docker loopback publishing remain enforced. Do not reverse-proxy it to a LAN
or public network. SQLite has no network listener.

Server/Enterprise still require PostgreSQL and retain production authentication,
secure-cookie requirements and their separate Compose migration ordering.
Local Desktop's production-runtime exception is accepted only in Electron and
still requires Local mode and loopback. Docker Local does not use that exception.

REST remains the existing bounded GET/JSON connector with explicit mapping,
endpoint/authentication configuration and SSRF safeguards. This change does not
add arbitrary API protocols, pagination or unattended scheduling. Existing source
health/status metadata behavior is not expanded; collected event data persists.

## Verification

See [SQLITE-VERIFICATION.md](SQLITE-VERIFICATION.md) for commands, evidence and
explicit platform limitations. Clean Windows installation and real power-loss
testing must be completed on the target IPC before industrial production use.
