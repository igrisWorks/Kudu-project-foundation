# KuduNS Desktop

Desktop now offers **Start KuduNS Local** using embedded SQLite, or **Continue to
server** using the existing remote authenticated edition.

## Build and development

Run from `VS Code Edit/` with Node.js 24 and pnpm 10.26.1:

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm desktop:dev
pnpm desktop:package:appimage   # Linux host
pnpm desktop:package:deb        # Linux host
pnpm desktop:package:win        # Windows host, NSIS x64
```

Package on the target OS. Windows packaging is intentionally rejected on Linux
rather than shipping a Linux native SQLite module in a Windows installer.
Installers are unsigned unless signing is configured separately.

Root packaging builds the production frontend/backend, uses pnpm deploy to make
a self-contained backend dependency tree, and includes SQLite migrations and
the production frontend in `resources/local-backend/`. Generated staging content
is ignored under `desktop/local-backend/`; release output is ignored under
`release/desktop/`. Electron/Electron Builder remain isolated from server Docker
dependency installation in `desktop/`.

`better-sqlite3` 13 uses N-API and requires Node 22+. The chosen package loads on
the project Node 24 runtime and compiles during dependency installation (Python 3
and target-OS C++ build tools are required on the build machine, not the IPC).
N-API avoids a separate Electron-specific ABI rebuild, but packaged native loading must also be tested
on each target platform. Linux evidence is recorded in
[SQLITE-VERIFICATION.md](SQLITE-VERIFICATION.md); a Linux build does not prove a
clean Windows install.

## Local runtime

The main process starts only its own bundled Electron utility-process backend.
It passes `app.getPath("userData")`, loopback `127.0.0.1`, an ephemeral port, the
bundled migrations/frontend locations, and Local mode. It waits for database and
API readiness before loading the Local page. It never adopts/stops an unrelated
server or PostgreSQL service. A single-instance lock avoids duplicate desktop
launches. App exit stops the owned backend with a graceful shutdown window.

SQLite is created and migrated automatically. PostgreSQL, Docker, database roles,
credentials and operator login are not required. Exact paths, backups and a
restricted **Open data folder** action are available in Settings.
See [LOCAL-SQLITE.md](LOCAL-SQLITE.md) for legacy-data migration and recovery.

If startup fails, inspect `local-runtime.log` in the Electron user-data folder.
Do not delete `kuduns.db` or its sidecars to bypass an error.

## Secure remote server connection

The existing server-address validation, explicit connection confirmation,
authenticated browser session and origin-restricted navigation remain. HTTP
requires the existing explicit insecure-transport acknowledgment. Local's folder
bridge is not installed in remote Server windows. The desktop connection page
does not persist server passwords or API credentials.

## Linux runtime and sandbox

Use a normal unprivileged desktop account and working Chromium sandbox support
(including allowed unprivileged user namespaces). Never use `--no-sandbox` as an
application workaround. The app fails closed when sandbox support is disabled
or it is run as root.

AppImage may require FUSE; extracting it and running `AppRun` as a regular user
is an alternative on supported hosts. `pnpm desktop:check:runtime` diagnoses the
existing AppImage runtime prerequisites. Missing desktop libraries, display,
FUSE or user-namespace support in Replit are not proof of an application defect.
Full GUI/installer acceptance must run on a suitable target desktop.
