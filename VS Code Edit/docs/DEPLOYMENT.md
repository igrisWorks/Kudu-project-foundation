# Deployment

## Supported baseline

The production target is Docker Compose v2.24 or newer on Ubuntu LTS or Debian stable. Docker Engine and the Compose plugin must already be installed. The application image is built with Node `24.22.1-bookworm-slim`; PostgreSQL uses `18.6-alpine`. The app image contains the built frontend, backend, runtime-only dependencies, and SQL migrations. Its runtime stage contains Node but no pnpm, TypeScript, Vite, or development server.

## Build and run

1. Copy `.env.example` to `.env` and protect it:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

2. Set `POSTGRES_PASSWORD` to a strong private URL-safe value (letters and numbers avoid URL-encoding errors). Generate and set `KUDU_AUTH_PASSWORD_HASH` and `SESSION_SECRET` as described below. The scrypt hash contains `$`; quote the complete value with single quotes when storing it in `.env`. Replit Secrets or a protected environment may store the raw value without shell quoting. Keep `.env` out of Git and image bundles.
3. Keep `KUDU_COOKIE_SECURE=true` and set `KUDU_VERSION` to the release tag being deployed. Create `imports/` if local files will be imported.
4. Build the app image and start Compose:

   ```sh
   mkdir -p imports
   docker compose up --build -d
   ```

   Compose waits for PostgreSQL health, runs the one-shot `migrate` service, and starts the app only after migrations succeed. A migration error prevents the app from starting. The migration runner checks checksums and uses a PostgreSQL advisory lock to serialize concurrent migration attempts.

5. Check `docker compose ps`, review `docker compose logs --tail=100 migrate app db`, and verify `http://localhost:3000/healthz` plus `http://localhost:3000/api/v1/health`.

Compose binds the app and PostgreSQL ports to `127.0.0.1`; PostgreSQL is not publicly exposed. The app listens on `0.0.0.0` inside its container so the loopback host mapping can reach it. For remote browser access, terminate HTTPS at a trusted same-host reverse proxy and keep Kudu bound to loopback. No proxy or TLS service is included. Production configuration rejects disabled Secure cookies; direct loopback HTTP is for isolated development only.

The container gets configuration from Compose at runtime. Docker builds reinstall the standard CA bundle and keep TLS verification enabled. If a TLS-inspection proxy requires an additional trusted CA, provide the approved PEM bundle through `KUDU_DOCKER_CA_CERT`; Compose mounts it as a BuildKit build secret only during dependency downloads. It is not a Docker build argument and is not copied into the runtime image. Keep the certificate out of `.env`, the repository, and image archives. See [Local Docker certificate handling](LOCAL-DOCKER.md#docker-build-certificates) for export, retry, and removal steps.

`.env`, `.env.sources`, local imports, certificates, and database dumps are excluded from the Docker build context. Production requires a valid auth hash, a session secret, database settings, and `KUDU_COOKIE_SECURE=true`; missing or invalid authentication configuration produces an actionable startup error before the app or migration runner can access the database.

`KUDU_LOCAL_MODE=true` is a development/local-only switch for the no-login Local Web Edition. It is not a production deployment option: the backend rejects it whenever `NODE_ENV=production` and rejects any non-loopback application bind. The production `docker-compose.yml` does not enable local mode. A separate, explicitly local Docker configuration is documented in [LOCAL-DOCKER.md](LOCAL-DOCKER.md); do not expose that no-login service beyond host loopback or use its settings volume as production secret storage. Production continues to use the authenticated application, protected environment secrets, HTTPS, and the existing migration service.

## Authentication setup

1. From `VS Code Edit/`, run `pnpm --filter @kudu/backend auth:hash-password`. The interactive prompt does not echo the password and requires at least 12 characters. Store the resulting `KUDU_AUTH_PASSWORD_HASH` in Replit Secrets or a protected host environment; do not put it in Git or a command-line argument.
2. Set `SESSION_SECRET` to a randomly generated value of at least 32 bytes in the same protected environment. Replit installations should use the Secrets panel. For a self-hosted installation, generate a value with a secure random generator and store it outside the repository.
3. Keep `KUDU_COOKIE_SECURE=true` in production. For local development only, `false` may be used on isolated loopback HTTP when the browser does not send Secure cookies.
4. Restart Kudu. In production, a missing or malformed password hash, a session secret shorter than 32 bytes, or disabled Secure cookies prevents startup. In development, incomplete authentication configuration keeps private API routes fail-closed while public health probes remain available.

The session cookie is `HttpOnly`, `SameSite=Strict`, and Secure by default. The CSRF cookie is same-site and must accompany the `X-Kudu-CSRF` header on every protected API request. Sessions are in-memory, expire after 8 hours, and are invalidated by restarting the single Kudu instance. This feature supports one shared operator password only; it does not provide roles or individual accounts.

Keep the reverse proxy on the same host where possible. Kudu does not trust forwarded client-IP headers by default; ensure the proxy overwrites forwarded headers. Login throttling uses the direct peer address, so users behind one proxy share that rate limit. Configure proxy TLS and firewall rules to match the site's operational policy.

## Local CSV/JSON imports

Place operator-controlled files under the host `imports/` directory. Register a `csv_file` or `json_file` source with a safe relative path such as `plant/events.csv`, then use the source detail page's on-demand import action. Compose mounts the configured host directory read-only at `/imports`; set `KUDU_IMPORT_HOST_DIRECTORY` to use a different host folder. For direct Node development, set `KUDU_IMPORT_DIRECTORY` to the local import root (relative values resolve from the project root).

Imports are limited to 5 MiB and 1,000 records. The API accepts only a registered source ID, never a path, and will not follow a symlink outside the import root. Import counts and per-record errors are returned immediately; there is no scheduler or persisted run history. The endpoint requires an authenticated session and CSRF header.

## On-demand REST API sync

Register an HTTPS base URL, relative endpoint path, GET method, JSON response path, bounded timeout/size/record limits, an active event mapping, and optionally `authMode: "bearer"` with an `env:KUDU_SOURCE_*` reference. Provision the referenced variable outside the registry. For Compose, put only those `KUDU_SOURCE_*` values in a host-side `.env.sources` file; it is optional, ignored by Git, and passed only to the app container. Quote values containing `$` with single quotes and protect the file with `chmod 600 .env.sources`. Never add source tokens to the image or offline image archive. Only bearer authentication is implemented, and bearer tokens require HTTPS. Registration, editing, listing, and viewing do not contact the remote service. Only an operator's **Sync now** action makes a request. Sync results are returned immediately and are not stored as run history.

By default, the connector blocks loopback, private, link-local, multicast, reserved, and other special-use network destinations. DNS results are checked and pinned for the request; each redirect is revalidated and bearer credentials are not forwarded to another origin. To trust specific on-premises API hosts, set `KUDU_REST_TRUSTED_HOSTS` to a comma-separated list of exact hostnames/IP addresses, for example `plc-api.internal,10.20.30.40`. Exact allowlisted hosts may resolve to private IPv4 or IPv6 ULA addresses, but loopback, link-local, multicast, and reserved addresses remain blocked. Wildcards are not accepted. Keep this allowlist under trusted operator control.

The sync endpoint requires an authenticated session and CSRF header. Keep the application bound to loopback; any remote browser access should pass through a same-host TLS reverse proxy.

## Operations

```sh
docker compose ps
docker compose logs -f app migrate db
docker compose stop
docker compose down
```

`docker compose down` removes containers and the default network but preserves the named `kudu-postgres` volume and the host import directory. `docker compose down -v` deletes the database volume and permanently removes stored data; do not use it for routine shutdown. The app image contains the frontend, backend, and migrations. Recreated app containers lose in-memory sessions and login-throttle counters; operators must sign in again. Imported files remain in the host directory. Container logs are managed by the host Docker logging driver.

### Upgrade

Back up the database before an upgrade. Update `KUDU_VERSION` to the release tag, then rebuild and start:

```sh
docker compose up --build -d
```

The new image runs pending migrations before the app starts. Migrations are forward-only; do not edit a migration that has already been applied. Keep the old versioned image and pre-upgrade backup until the new release is verified. Reverting only the image may not work after a schema migration; a full rollback may require restoring the pre-upgrade database, which replaces current data.

### Credential rotation

- **Database password:** Changing `POSTGRES_PASSWORD` in `.env` does not change the role password in an existing PostgreSQL volume; it only initializes a new data directory. Connect using the current database credential with `docker compose exec db sh -ec 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, then run `\password` at the `psql` prompt. Update `.env` with the same new URL-safe password, run `docker compose run --rm migrate`, and recreate the app with `docker compose up -d --force-recreate app`. Do not remove the volume to rotate credentials.
- **Operator password:** Generate a new scrypt hash with `pnpm --filter @kudu/backend auth:hash-password`, update `KUDU_AUTH_PASSWORD_HASH` in the protected environment, and recreate the app.
- **Session secret:** Replace `SESSION_SECRET` with a new random value of at least 32 bytes and recreate the app. Existing sessions become invalid.
- **REST bearer token:** Rotate the token with its provider, update the corresponding value in `.env.sources`, and recreate the app. Do not store it in the Compose file or image.

### Backup

Use a protected host path outside the repository. The custom-format dump includes database records and must be handled as sensitive operational data; it does not include files in the host `imports/` directory or deployment settings:

```sh
BACKUP_DIR=/secure/backups
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/kudu-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$BACKUP"
sha256sum "$BACKUP" > "$BACKUP.sha256"
docker compose exec -T db pg_restore --list < "$BACKUP" > /dev/null
```

Store the dump and checksum in access-controlled, preferably encrypted off-host storage. This procedure is manual; Kudu does not schedule backups or manage retention.

Back up imported files separately if they must survive host loss. Store `.env` and `.env.sources` separately in an approved secrets manager; do not include them in the database backup or image archive.

### Restore

**Warning: `pg_restore --clean` drops and replaces objects from the dump in the configured database. Stop the app and preserve a separate copy of the current database before restoring.**

```sh
BACKUP=/secure/backups/kudu-YYYYMMDDTHHMMSSZ.dump
sha256sum -c "$BACKUP.sha256"
docker compose stop app
docker compose exec -T db sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --clean --if-exists --single-transaction --no-owner -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$BACKUP"
docker compose run --rm migrate
docker compose up -d app
```

Use a dump produced by a compatible PostgreSQL major version. Verify the application health endpoints and expected records before deleting the pre-restore copy.

### Offline image transfer

Build and export the exact tagged app and database images on an internet-connected machine of the same CPU architecture as the offline host. Current tags are Kudu `0.1.0` and PostgreSQL `18.6-alpine`; the app image uses Node `24.22.1-bookworm-slim` in its build and runtime stages.

```sh
KUDU_VERSION=0.1.0
docker pull postgres:18.6-alpine
docker build --pull --build-arg KUDU_VERSION="$KUDU_VERSION" \
  -t "kudu:$KUDU_VERSION" .
docker save -o "kudu-images-$KUDU_VERSION.tar" \
  "kudu:$KUDU_VERSION" postgres:18.6-alpine
sha256sum "kudu-images-$KUDU_VERSION.tar" \
  > "kudu-images-$KUDU_VERSION.tar.sha256"
```

Transfer the tar file, its checksum, `docker-compose.yml`, and `.env.example` through the approved offline transfer channel. Do **not** include `.env`, `.env.sources`, database dumps, or credentials in the image bundle. Provision secrets separately on the offline host. Docker Engine and Compose v2.24+ must already be installed there; this guide does not provide offline Docker installation.

On the disconnected host, set `KUDU_VERSION` in `.env` to the bundle tag, configure all required database/auth settings, and then:

```sh
sha256sum -c "kudu-images-$KUDU_VERSION.tar.sha256"
docker load -i "kudu-images-$KUDU_VERSION.tar"
mkdir -p imports
docker compose up -d --no-build --pull never
```

`--no-build --pull never` prevents startup from building the app or downloading either image. The loaded image tags must exactly match `KUDU_VERSION` and `postgres:18.6-alpine` in Compose. Use a separate `.env.sources` on the offline host if REST bearer credentials are required.

Authentication now protects the application API, but this package is not a complete industrial-control security boundary. It still lacks per-user roles, SSO, automated backup retention, and monitoring. Do not expose PLC control networks or permit PLC writes through this registry. Source registration does not connect or ingest automatically.
