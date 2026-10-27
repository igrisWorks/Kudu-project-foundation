# Deployment

## Supported baseline

The initial deployment target is Docker Compose on Ubuntu Linux LTS or Debian stable, with Node.js 24 and PostgreSQL 18. The application container is built from the included Node 24 Debian image; PostgreSQL runs in a separate container with a named persistent volume mounted at `/var/lib/postgresql`, as required by the official PostgreSQL 18 image.

## Build and run

1. Copy `.env.example` to `.env`.
2. Set `POSTGRES_PASSWORD` to a strong private URL-safe value (letters and numbers avoid URL-encoding errors). Do not commit or share `.env`.
3. Build and start the services:

   ```sh
   docker compose up --build -d
   ```

4. Apply database migrations:

   ```sh
   docker compose exec app pnpm db:migrate
   ```

5. Check `http://localhost:3000/api/v1/health` and open `http://localhost:3000`.

The Compose file binds both PostgreSQL and the web application to loopback only. Kudu requires an operator password for registry and event API access; only health checks and the authentication bootstrap routes are public. Keep the loopback binding. If remote browser access is needed, use a same-host TLS reverse proxy, keep the Kudu app itself bound to loopback, and do not treat TLS as a replacement for Kudu authentication.

## Authentication setup

1. From `VS Code Edit/`, run `pnpm --filter @kudu/backend auth:hash-password`. The interactive prompt does not echo the password and requires at least 12 characters. Store the resulting `KUDU_AUTH_PASSWORD_HASH` in Replit Secrets or a protected host environment; do not put it in Git or a command-line argument.
2. Set `SESSION_SECRET` to a randomly generated value of at least 32 bytes in the same protected environment. Replit installations should use the Secrets panel. For a self-hosted installation, generate a value with a secure random generator and store it outside the repository.
3. Keep `KUDU_COOKIE_SECURE=true` for HTTPS and TLS reverse-proxy deployments. Set it to `false` only for isolated loopback-only HTTP development when the browser does not send Secure cookies.
4. Restart Kudu. Without a valid password hash and session secret, private API routes return `503 AUTH_NOT_CONFIGURED`; `/healthz` and `/api/v1/health` remain available.

The session cookie is `HttpOnly`, `SameSite=Strict`, and Secure by default. The CSRF cookie is same-site and must accompany the `X-Kudu-CSRF` header on every protected API request. Sessions are in-memory, expire after 8 hours, and are invalidated by restarting the single Kudu instance. This feature supports one shared operator password only; it does not provide roles or individual accounts.

Keep the reverse proxy on the same host where possible. Kudu does not trust forwarded client-IP headers by default; ensure the proxy overwrites forwarded headers. Login throttling uses the direct peer address, so users behind one proxy share that rate limit. Configure proxy TLS, firewall rules, and backups to match the site's operational policy.

## Local CSV/JSON imports

Place operator-controlled files under the host `imports/` directory. Register a `csv_file` or `json_file` source with a safe relative path such as `plant/events.csv`, then use the source detail page's on-demand import action. Compose mounts the configured host directory read-only at `/imports`; set `KUDU_IMPORT_HOST_DIRECTORY` to use a different host folder. For direct Node development, set `KUDU_IMPORT_DIRECTORY` to the local import root (relative values resolve from the project root).

Imports are limited to 5 MiB and 1,000 records. The API accepts only a registered source ID, never a path, and will not follow a symlink outside the import root. Import counts and per-record errors are returned immediately; there is no scheduler or persisted run history. The endpoint requires an authenticated session and CSRF header.

## On-demand REST API sync

Register an HTTPS base URL, relative endpoint path, GET method, JSON response path, bounded timeout/size/record limits, an active event mapping, and optionally `authMode: "bearer"` with an `env:KUDU_SOURCE_*` reference. Provision the referenced environment variable outside the registry; only bearer authentication is implemented, and bearer tokens require HTTPS. Registration, editing, listing, and viewing do not contact the remote service. Only an operator's **Sync now** action makes a request. Sync results are returned immediately and are not stored as run history.

By default, the connector blocks loopback, private, link-local, multicast, reserved, and other special-use network destinations. DNS results are checked and pinned for the request; each redirect is revalidated and bearer credentials are not forwarded to another origin. To trust specific on-premises API hosts, set `KUDU_REST_TRUSTED_HOSTS` to a comma-separated list of exact hostnames/IP addresses, for example `plc-api.internal,10.20.30.40`. Exact allowlisted hosts may resolve to private IPv4 or IPv6 ULA addresses, but loopback, link-local, multicast, and reserved addresses remain blocked. Wildcards are not accepted. Keep this allowlist under trusted operator control.

The sync endpoint requires an authenticated session and CSRF header. Keep the application bound to loopback; any remote browser access should pass through a same-host TLS reverse proxy.

## Operations

```sh
docker compose ps
docker compose logs -f app
docker compose logs -f db
docker compose down
```

`docker compose down` preserves the named database volume. `docker compose down -v` deletes it and permanently removes stored database data; do not use that command for routine shutdown.

Authentication now protects the application API, but this package is not a complete industrial-control security boundary. It still lacks per-user roles, SSO, backup automation, monitoring, and upgrade/rollback procedures. Do not expose PLC control networks or permit PLC writes through this registry. Source registration does not connect or ingest automatically.
