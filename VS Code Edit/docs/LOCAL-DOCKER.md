# Local Web Edition in Docker

The normal `docker-compose.yml` remains the authenticated production deployment. Use the separate `docker-compose.local.yml` only when you want the no-login Local Web Edition in Docker.

## Start without installing PostgreSQL

From `VS Code Edit/`:

```sh
pnpm docker:local
```

Open `http://127.0.0.1:3000`. The published port is bound to host loopback. The Fastify application itself listens only on container loopback; an in-container proxy forwards browser requests to that listener and rejects non-loopback `Host` values. Do not change the published address to `0.0.0.0`, add a public reverse proxy, or expose this no-login service to a LAN.

To choose a different host port, set `KUDU_LOCAL_WEB_PORT` in the current shell or in the project `.env` file. For example, on Linux/macOS:

```sh
KUDU_LOCAL_WEB_PORT=3002 pnpm docker:local
```

In PowerShell:

```powershell
$env:KUDU_LOCAL_WEB_PORT = "3002"
pnpm docker:local
```

The host port is configurable; the container's proxy and health-check port remain `3000`. The launcher checks `127.0.0.1` before starting Compose. If that port is occupied, it reports the conflict and a replacement-port example without stopping or changing the other service. To identify the listener, use `Get-NetTCPConnection -LocalPort 3000 -State Listen` on Windows or `lsof -nP -iTCP:3000 -sTCP:LISTEN` on macOS/Linux. Direct Compose use is also supported:

```sh
docker compose -p kuduns-local -f docker-compose.local.yml up --build -d
```

## Docker build certificates

The Dockerfile reinstalls the standard CA bundle in the build stage and tells Node to use the operating-system trust store. TLS verification remains enabled. No additional certificate is needed on networks where the standard roots are trusted.

If a corporate TLS-inspection proxy causes errors such as `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or `CERT_AUTHORITY_INVALID`, the container does not trust the proxy's issuing CA. Ask IT for the approved root/intermediate CA bundle, or export the approved CA from the Windows certificate store as Base-64 X.509. Provide the **PEM certificate contents**, not a path, in `KUDU_DOCKER_CA_CERT` for the build process. Do not export a private key.

PowerShell:

```powershell
$env:KUDU_DOCKER_CA_CERT = Get-Content -Raw 'C:\secure\approved-root-ca.pem'
pnpm docker:local
Remove-Item Env:KUDU_DOCKER_CA_CERT
```

Linux/macOS:

```sh
export KUDU_DOCKER_CA_CERT="$(cat /secure/approved-root-ca.pem)"
pnpm docker:local
unset KUDU_DOCKER_CA_CERT
```

The Compose build secret passes that value only to BuildKit during dependency-download steps. The build validates that it contains PEM-encoded CA certificates; it is not copied into the source tree, a Docker build argument, or the final runtime image. Keep the certificate out of `.env`, `.env.example`, and version control. Docker Compose environment-backed build secrets are not supported by `docker stack deploy`; use the Compose CLI documented here.

If the certificate was replaced and a cached dependency-download step prevents it from being checked again, rebuild with `docker compose -p kuduns-local -f docker-compose.local.yml build --no-cache app`, then run `docker compose -p kuduns-local -f docker-compose.local.yml up -d --no-build`. Remove `KUDU_DOCKER_CA_CERT` from the shell environment when it is no longer needed. Never disable TLS verification or set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

This repository's `.replit` deployment configuration does not invoke the Dockerfile; its Docker BuildKit secret setting applies when Docker Compose is run from a process that has `KUDU_DOCKER_CA_CERT` in its environment. Replit-managed build-secret forwarding was not verified. If a managed build cannot provide a BuildKit secret, build on a trusted Docker Compose/BuildKit host and transfer the image using the offline deployment procedure rather than embedding a CA in the image or disabling verification.

Local mode does not start or install PostgreSQL by default. In Settings, configure the PostgreSQL host, port, target database, and dedicated application role. Enable **Require TLS and verify the PostgreSQL server certificate** when the database requires TLS and presents a chain trusted by the operating system. Custom per-database CA uploads are not supported. Use **Test connection** before saving.

Use **Create KuduNS Database** when the target database or application role is missing. Before confirming, review the displayed server and database name. Kudu uses the entered administrator credentials only for that request, creates missing objects, does not drop or overwrite an existing database or change an existing role password, runs migrations as the dedicated application role, verifies the application connection, then saves only the application credentials. It revokes temporary database-wide `CREATE` permission before saving.

## PostgreSQL connection choices

- **PostgreSQL on the Docker host:** use `host.docker.internal` and the host PostgreSQL port. The Compose file provides the `host-gateway` mapping for Linux Docker Engine as well as Docker Desktop.
- **PostgreSQL in another container:** attach both containers to a user-defined Docker network. By default, this Compose file creates `kuduns-local-postgres`; connect an existing database container with `docker network connect kuduns-local-postgres <postgres-container>`, then use its container name or network alias as the host. To use a pre-existing user-defined network instead, set `KUDU_POSTGRES_NETWORK` to its name and `KUDU_POSTGRES_NETWORK_EXTERNAL=true`. `localhost` inside Kudu's container means the Kudu container, not another container.
- **Optional PostgreSQL managed by this Compose project:** set `KUDU_LOCAL_POSTGRES_ADMIN_PASSWORD` in the shell environment, then run:

  ```sh
  KUDU_LOCAL_POSTGRES_ADMIN_PASSWORD='a-new-local-admin-password' \
    pnpm docker:local -- --profile local-postgres
  ```

  Configure the Kudu Settings page with host `db`, port `5432`, maintenance database `kudu` as the target, and a separate application username/password. Use `kuduadmin` (or the configured `KUDU_LOCAL_POSTGRES_ADMIN_USER`) only in the one-time initialization form. This database service is opt-in and is not a PostgreSQL installer.
- **PostgreSQL installed natively on the same computer:** use the native `pnpm dev` Local Web Edition and its loopback database address, or connect from Docker through `host.docker.internal` as above.

Do not use a production database, production credentials, or a PostgreSQL administrator as Kudu's runtime application account.

## Persistence and shutdown

The `kudu-local-settings` named volume stores the protected settings file. In the Linux container, the file is created with owner-only `0600` permissions and the runtime runs as the unprivileged `node` user; Windows-native storage continues to use the existing DPAPI protection. The optional `kudu-local-postgres` volume stores that service's database. Both survive container recreation and ordinary `docker compose down`.

To stop the local app without deleting data:

```sh
docker compose -p kuduns-local -f docker-compose.local.yml down
```

To restart the app containers without rebuilding or deleting their data:

```sh
docker compose -p kuduns-local -f docker-compose.local.yml restart
```

Do not add `-v` unless you intend to permanently delete the local settings and, if enabled, PostgreSQL data volumes.

The Settings UI, DB connection, provisioning, and migrations reuse the Local Web Edition backend. Docker local-mode is intentionally rejected outside a Linux container and remains unavailable in production. The ordinary authenticated Compose deployment does not enable this mode.
