# Optional Docker Local Edition

Docker is optional. For a clean IPC without Docker or PostgreSQL, use
[LOCAL-SQLITE.md](LOCAL-SQLITE.md). Docker Local also uses embedded SQLite, not a
PostgreSQL container or external database.

From the authoritative `VS Code Edit/` directory:

```sh
pnpm docker:local
```

Open `http://127.0.0.1:3000`. The helper checks for a port collision before running
Compose and does not stop another service. Set `KUDU_LOCAL_WEB_PORT` to a different
host port if needed. Compose publishes only `127.0.0.1`; never replace that binding
with a LAN/public bind for this no-login edition.

The app's loopback backend listens on internal port 3001. The existing constrained
container-local proxy serves the loopback-published port 3000. Health checks now
check the database-backed readiness endpoint directly on port 3001.
There is no PostgreSQL dependency, database listener, role initialization, saved
database password or DPAPI operation in this Linux container.

`KUDU_DATA_DIR=/var/lib/kudu` stores `kuduns.db` and `backups/` in the persistent
`kudu-local-settings` volume. The old volume name is intentionally preserved;
legacy `settings.json` is not deleted. Ordinary container restart/recreation keeps
the SQLite database. Do not remove data volumes as a troubleshooting step.

The previous optional `local-postgres` profile has been removed. Existing
PostgreSQL containers and volumes are **not** stopped, deleted or automatically
imported. Use the explicit read-only migration utility in [LOCAL-SQLITE.md](LOCAL-SQLITE.md)
and choose the destination deliberately before moving data into the Local volume.

Settings creates consistent SQLite backup files. Export a completed backup from
the volume/container to separate storage; do not copy only a live WAL-mode
database file. Keep older backups until an explicit retention policy is agreed.

## Corporate CA handling

The existing optional BuildKit-only `corporate-ca` secret is preserved. Set
`KUDU_DOCKER_CA_CERT` to trusted PEM **contents**, not a filename, only for the
build command. Compose provides it as a BuildKit secret and the validation helper
checks it. Example:

```sh
KUDU_DOCKER_CA_CERT="$(cat /trusted/path/corporate-ca.pem)" pnpm docker:local
```

PowerShell can set `$env:KUDU_DOCKER_CA_CERT = Get-Content -Raw <trusted-path>`
before running the helper. No custom certificate is needed on a normal network.
TLS verification remains enabled; do not use `strict-ssl=false` or disable TLS
verification. Custom build trust is not copied into the runtime image.

## Server/Enterprise is separate

`docker-compose.yml`, PostgreSQL health dependencies, the migration service and
production authentication remain the Server/Enterprise deployment path.
See [DEPLOYMENT.md](DEPLOYMENT.md). Do not confuse the old Local PostgreSQL Docker
image with a newly built SQLite Local image: rebuild before expecting parity.
