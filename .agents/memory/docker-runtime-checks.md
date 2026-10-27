---
name: Docker runtime checks
description: A Docker exec limitation observed while validating Kudu in this Replit workspace.
---

PostgreSQL 18 started in Docker, and the Kudu migration runner plus host-side `psql` worked through the published port. Docker `exec` and the container's exec-based health check returned `OCI runtime exec failed ... setns process` errors.

Compose's `POSTGRES_PASSWORD` only initializes a new PostgreSQL data directory; changing it does not rotate the password in an existing named volume. In this workspace, host-side authentication continued to require the volume's original password after the Compose environment changed.

**Why:** this appears to be a workspace container-runtime limitation, not a Kudu or Compose configuration error; the same Compose setup is intended for ordinary Ubuntu/Debian Docker hosts.

**How to apply:** if this exact error recurs, validate the service from the host through its published port and avoid changing application health behavior solely to work around it. Re-check `docker exec` on the target deployment host. If a password change appears ineffective, do not remove the volume; authenticate with the existing database credential and rotate it through PostgreSQL.
