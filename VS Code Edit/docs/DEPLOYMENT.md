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

The Compose file binds both PostgreSQL and the web application to loopback only. The API has no authentication or authorization, so this build must not be exposed to untrusted networks. A reverse proxy or TLS alone does not add access control. Keep it on a trusted local machine/network until authentication is implemented. Configure firewall rules and backups to match the site's operational policy.

## Local CSV/JSON imports

Place operator-controlled files under the host `imports/` directory. Register a `csv_file` or `json_file` source with a safe relative path such as `plant/events.csv`, then use the source detail page's on-demand import action. Compose mounts the configured host directory read-only at `/imports`; set `KUDU_IMPORT_HOST_DIRECTORY` to use a different host folder. For direct Node development, set `KUDU_IMPORT_DIRECTORY` to the local import root (relative values resolve from the project root).

Imports are limited to 5 MiB and 1,000 records. The API accepts only a registered source ID, never a path, and will not follow a symlink outside the import root. Import counts and per-record errors are returned immediately; there is no scheduler or persisted run history. The endpoint inherits the API's unauthenticated access model and is safe to use only under the existing loopback/trusted-network restriction.

## On-demand REST API sync

Register an HTTPS base URL, relative endpoint path, GET method, JSON response path, bounded timeout/size/record limits, an active event mapping, and optionally `authMode: "bearer"` with an `env:KUDU_SOURCE_*` reference. Provision the referenced environment variable outside the registry; only bearer authentication is implemented, and bearer tokens require HTTPS. Registration, editing, listing, and viewing do not contact the remote service. Only an operator's **Sync now** action makes a request. Sync results are returned immediately and are not stored as run history.

By default, the connector blocks loopback, private, link-local, multicast, reserved, and other special-use network destinations. DNS results are checked and pinned for the request; each redirect is revalidated and bearer credentials are not forwarded to another origin. To trust specific on-premises API hosts, set `KUDU_REST_TRUSTED_HOSTS` to a comma-separated list of exact hostnames/IP addresses, for example `plc-api.internal,10.20.30.40`. Exact allowlisted hosts may resolve to private IPv4 or IPv6 ULA addresses, but loopback, link-local, multicast, and reserved addresses remain blocked. Wildcards are not accepted. Keep this allowlist under trusted operator control.

The sync endpoint is unauthenticated, as are the other API write routes. Keep the application bound to loopback and do not expose it to untrusted networks.

## Operations

```sh
docker compose ps
docker compose logs -f app
docker compose logs -f db
docker compose down
```

`docker compose down` preserves the named database volume. `docker compose down -v` deletes it and permanently removes stored database data; do not use that command for routine shutdown.

This package is not yet a hardened production product: authentication, authorization, backup automation, monitoring, and upgrade/rollback procedures must be designed before handling sensitive operational data or exposing it beyond loopback. Source registration does not connect, ingest, or perform PLC writes.
