# KuduNS Desktop

The desktop shell opens the existing KuduNS web application in a restricted Electron window. It does not contain a second copy of the registry UI or change the API/authentication contract.

## Prerequisites and development

- Linux x86_64. The documented minimum deployment baseline is Ubuntu 22.04 LTS or Debian 12; this is a conservative target, not a verified support claim until the manual smoke test below passes on those systems.
- A graphical X11 or Wayland session, an unprivileged desktop account, and unprivileged user namespaces for Electron's Chromium sandbox.
- Node.js 24, pnpm 10.26.1 through Corepack, and network access to install pinned Electron build tools on the build machine. Runtime users do not need Node.js or pnpm.
- The packaged Electron executable requires GLIBC symbols through `GLIBC_2.25`.

The AppImage does not bundle these host libraries: GLib/GObject/GIO, GTK 3, Pango, Cairo, ATK/AT-SPI, NSS/NSPR, X11/XCB and related extensions, GBM, ALSA, CUPS, and D-Bus. Normal AppImage mounting also requires `libfuse.so.2`.

On Ubuntu 22.04 or Debian 12, install the runtime packages from the distribution repositories:

```sh
sudo apt update
sudo apt install \
  libfuse2 libglib2.0-0 libgtk-3-0 libnss3 libnspr4 \
  libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
  libasound2 libcups2 libdbus-1-3 libcairo2 libpango-1.0-0 \
  libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxrandr2 libgbm1 libxkbcommon0 \
  libexpat1 libudev1 libcap2
```

From `VS Code Edit/`:

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm desktop:dev
```

Electron and Electron Builder are pinned in the isolated `desktop/` package and its lockfile so the existing web/Docker install is unchanged. The pinned Electron Builder patch makes the generated AppRun fail closed when sandbox prerequisites are missing; it does not inject `--no-sandbox`. The command builds a separate renderer into `frontend/dist-desktop`; the normal web build remains in `frontend/dist`. The desktop build uses the same React/Vite frontend and the existing local brand assets.

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

Electron Builder writes packages under `release/desktop/`. AppImage execution may require FUSE support on the target host. These commands package for Linux; cross-building from another operating system is not supported by this setup. The `.deb` target requires an authoritative `homepage` plus either `author.email` or `linux.maintainer`; the project owner must supply those values before a Debian package can be built. Desktop package artifacts are not included in the web runtime.

## Repeatable runtime verification

After building an AppImage, run the read-only prerequisite checker from the repository root:

```sh
pnpm desktop:check:runtime
# Or pass a transferred AppImage explicitly:
bash desktop/check-appimage-runtime.sh /path/to/KuduNS-0.1.0.AppImage
```

It extracts the AppImage into a temporary directory, verifies that AppRun rejects root and explicit `--no-sandbox` requests without injecting the flag, checks packaged ELF dependencies with `ldd`, checks for FUSE 2, tests unprivileged user namespaces, and checks for a display session. It makes no network calls and installs no packages. A pass only means these prerequisites appear present; it does not launch the UI or verify a server connection.

On a compatible desktop session:

Use only a disposable test server and test account. Bind the server to loopback for same-machine tests. If the client must connect from another machine, use an isolated private LAN with firewall rules; do not bind or forward the test service to a public interface. Use test-only database contents, credentials, and session settings—never production credentials or data. Prefer HTTPS with a certificate trusted by the test client. HTTP remains subject to the explicit warning and is for loopback or an isolated LAN only.

Record these outcomes separately; a pass in one does not establish the next:

1. **Packaging:** From `VS Code Edit/`, `pnpm desktop:package:appimage` exits successfully and creates `release/desktop/KuduNS-0.1.0.AppImage`. This verifies packaging only.
2. **Prerequisites:** `pnpm desktop:check:runtime` exits successfully on the target host. This does not launch Electron.
3. **GUI launch:** Run `./release/desktop/KuduNS-0.1.0.AppImage` as a normal user, without `sudo` or sandbox-disabling flags, and confirm the connection window appears.
4. **Health check:** Connect to the disposable server and confirm the desktop accepts its `GET /healthz` response before opening the app.
5. **Sign-in and navigation:** Sign in with the test account, verify cross-origin navigation is blocked, and confirm external HTTPS links open only in the system browser.

Also verify malformed URLs and non-HTTPS schemes are rejected, unacknowledged HTTP is blocked, the HTTP warning appears after acknowledgement, and an unavailable server produces a sanitized failure. Review application and system logs and configuration locations to confirm no password or session credential was written.

The generated AppRun refuses root execution, explicit `--no-sandbox` arguments, and hosts where `unshare -Ur true` fails. It never forwards or injects `--no-sandbox`; the Electron main-process guard remains defense in depth. Do not work around these checks; enable user namespaces only if permitted by the host's security policy.

For offline transfer, create and verify the checksum on the build machine from the artifact directory:

```sh
cd release/desktop
sha256sum KuduNS-0.1.0.AppImage > KuduNS-0.1.0.AppImage.sha256
sha256sum -c KuduNS-0.1.0.AppImage.sha256
```

Transfer both files and the runtime prerequisite list through approved media. On the destination, place the AppImage and checksum side by side, change into that directory, and run the same `sha256sum -c KuduNS-0.1.0.AppImage.sha256` command. This verifies the file on both machines without embedding a stale checksum in this guide. Stage the listed OS packages and their transitive dependencies from the matching signed Ubuntu/Debian repository or an approved local package mirror; the AppImage does not include these host libraries.

Troubleshooting:

- `dlopen(): error loading libfuse.so.2`: install `libfuse2` from the host distribution repository.
- `ldd` reports `not found`: install the corresponding OS package from the list above, then rerun the prerequisite checker.
- The launcher reports sandbox support is required: check `unshare -Ur true` as the normal desktop user. The launcher intentionally exits rather than disable the sandbox.
- A blank or unavailable server screen: verify the server base URL, trusted TLS certificate, and that `GET /healthz` returns `{"status":"ok"}` from that host.

## Security and limitations

Both windows use context isolation, disabled Node integration, sandboxing, and web security. The connection screen's preload exposes only two fixed IPC calls; the connected server window receives no preload bridge. The server window applies a restrictive content security policy and blocks cross-origin navigation. TLS certificate errors are not bypassed.

This milestone does not provide a managed local backend, bundled PostgreSQL, auto-updates, or per-user authentication. Server mode requires an already-running KuduNS server. In the current Replit container, AppImage launch stops at missing `libfuse.so.2`; `ldd` on the packaged Electron executable also reports missing GTK/GLib, NSS/NSPR, X11/XCB, audio, and accessibility libraries. No desktop window or server connection has been verified here.
