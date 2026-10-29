# Local Web Edition in Docker

The normal `docker-compose.yml` remains the authenticated production deployment. Use the separate `docker-compose.local.yml` only when you want the no-login Local Web Edition in Docker.

## Start without installing PostgreSQL

From `VS Code Edit/`:

```sh
docker compose -p kuduns-local -f docker-compose.local.yml up --build -d
```

Open `http://127.0.0.1:3000`. The published port is bound to host loopback. The Fastify application itself listens only on container loopback; an in-container proxy forwards browser requests to that listener and rejects non-loopback `Host` values. Do not change the published address to `0.0.0.0`, add a public reverse proxy, or expose this no-login service to a LAN.

Local mode does not start or install PostgreSQL by default. In Settings, configure the PostgreSQL host, port, target database, and dedicated application role. Use **Test connection** before saving. Use the explicit **Initialize missing objects** action only when the entered administrator account is authorized to create the missing database or role. Kudu does not store that administrator password. It verifies that the application role is not a superuser, runs the existing migrations as that role, and revokes temporary database-wide `CREATE` permission before saving the application credentials.

## PostgreSQL connection choices

- **PostgreSQL on the Docker host:** use `host.docker.internal` and the host PostgreSQL port. The Compose file provides the `host-gateway` mapping for Linux Docker Engine as well as Docker Desktop.
- **PostgreSQL in another container:** attach both containers to a user-defined Docker network. By default, this Compose file creates `kuduns-local-postgres`; connect an existing database container with `docker network connect kuduns-local-postgres <postgres-container>`, then use its container name or network alias as the host. To use a pre-existing user-defined network instead, set `KUDU_POSTGRES_NETWORK` to its name and `KUDU_POSTGRES_NETWORK_EXTERNAL=true`. `localhost` inside Kudu's container means the Kudu container, not another container.
- **Optional PostgreSQL managed by this Compose project:** set `KUDU_LOCAL_POSTGRES_ADMIN_PASSWORD` in the shell environment, then run:

  ```sh
  KUDU_LOCAL_POSTGRES_ADMIN_PASSWORD='a-new-local-admin-password' \
    docker compose -p kuduns-local -f docker-compose.local.yml --profile local-postgres up --build -d
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

Do not add `-v` unless you intend to permanently delete the local settings and, if enabled, PostgreSQL data volumes.

The Settings UI, DB connection, provisioning, and migrations reuse the Local Web Edition backend. Docker local-mode is intentionally rejected outside a Linux container and remains unavailable in production. The ordinary authenticated Compose deployment does not enable this mode.
