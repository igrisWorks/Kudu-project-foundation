# KuduNS Desktop

The desktop shell opens the existing KuduNS web application in a restricted Electron window. It does not contain a second copy of the registry UI or change the API/authentication contract.

## Prerequisites and development

- Linux x86_64 on Ubuntu LTS or Debian stable.
- Node.js 24 and pnpm 10.26.1 through Corepack.
- A graphical X11 or Wayland session to open the Electron window.
- Network access to install the pinned Electron development tools.

From `VS Code Edit/`:

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm desktop:dev
```

Electron and Electron Builder are pinned in the isolated `desktop/` package and its lockfile so the existing web/Docker install is unchanged. The command builds a separate renderer into `frontend/dist-desktop`; the normal web build remains in `frontend/dist`. The desktop build uses the same React/Vite frontend and the existing local brand assets.

## Server connection

Enter the base URL of a running KuduNS server. The desktop requires an explicit native confirmation, checks the server's `/healthz` endpoint, then loads that server's existing app. The app continues to use its normal sign-in, session cookie, CSRF protection, and API routes. The desktop does not save server addresses or credentials.

HTTPS is preferred. HTTP requires an explicit acknowledgement and should only be used on a trusted local or isolated LAN connection. The connection screen rejects URLs with credentials, paths, query strings, or fragments. Navigation stays on the selected server origin. External links are opened in the system browser only for validated HTTPS URLs.

## Local mode status

Local mode is **not available in this milestone**. The desktop will not claim that a local service is ready, start PostgreSQL, adopt an existing process, or stop an unowned backend. PostgreSQL remains a separately managed prerequisite. Local mode also needs a safe packaged backend runtime and an external provisioning path for `DATABASE_URL`, `KUDU_AUTH_PASSWORD_HASH`, and `SESSION_SECRET`; this build intentionally does not persist those values or start a partially configured backend.

For now, an operator may configure and start the existing KuduNS backend separately, bound to loopback, then connect to its loopback URL through server mode. The local setup panel explains these prerequisites.

## Linux packages

On a Linux x86_64 build host, with the pinned dependencies installed:

```sh
pnpm desktop:package:deb
pnpm desktop:package:appimage
# or build both targets
pnpm desktop:package:linux
```

Electron Builder writes packages under `release/desktop/`. AppImage execution may require FUSE support on the target host. These commands package for Linux; cross-building from another operating system is not supported by this setup. The `.deb` target also requires an authoritative project homepage and maintainer contact in package metadata; those values must be supplied before a Debian package can be built. Desktop package artifacts are not included in the web runtime.

## Security and limitations

Both windows use context isolation, disabled Node integration, sandboxing, and web security. The connection screen's preload exposes only two fixed IPC calls; the connected server window receives no preload bridge. The server window applies a restrictive content security policy and blocks cross-origin navigation. TLS certificate errors are not bypassed.

This milestone does not provide a managed local backend, bundled PostgreSQL, auto-updates, or per-user authentication. Server mode requires an already-running KuduNS server. Only the focused desktop policy/build checks listed in the milestone report should be treated as verified; do not assume that a Linux installer was produced unless package artifacts are reported separately.
