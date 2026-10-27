---
name: Docker runtime checks
description: A Docker exec limitation observed while validating Kudu in this Replit workspace.
---

PostgreSQL 18 started in Docker, and the Kudu migration runner plus host-side `psql` worked through the published port. Docker `exec` and the container's exec-based health check returned `OCI runtime exec failed ... setns process` errors. A Docker build on the default bridge also failed DNS lookups for the npm registry even though the host could resolve and reach it; `docker build --network=host` worked.

Compose's `POSTGRES_PASSWORD` only initializes a new PostgreSQL data directory; changing it does not rotate the password in an existing named volume. In this workspace, host-side authentication continued to require the volume's original password after the Compose environment changed.

**Why:** these appear to be workspace container-runtime/network limitations, not Kudu or Compose configuration errors; the same Compose setup is intended for ordinary Ubuntu/Debian Docker hosts.

**How to apply:** if the exec error recurs, validate the service from the host through its published port and avoid changing application health behavior solely to work around it. Re-check `docker exec` on the target deployment host. If a Docker build reports registry DNS `EAI_AGAIN` while host connectivity works, retry that build with `--network=host` rather than adding network workarounds to the image. If a password change appears ineffective, do not remove the volume; authenticate with the existing database credential and rotate it through PostgreSQL.
