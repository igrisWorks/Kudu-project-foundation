---
name: Edition storage boundary
description: Product scope separating single-PC SQLite Local from authenticated PostgreSQL Server/Enterprise.
---

KuduNS Local must run on one industrial PC without installing PostgreSQL or Docker,
creating database roles, entering database passwords, or managing a database
server. Server/Enterprise must retain PostgreSQL and the secure authenticated
deployment path.

**Why:** The user explicitly requested embedded SQLite for Local, not a global
database replacement or a weakening of Server/Enterprise security.

**How to apply:** Keep storage and migration changes edition-aware. Preserve
industrial workflows in both editions. Never silently import, overwrite, drop or
delete legacy PostgreSQL data/volumes; migration into Local must be explicit and
source-read-only. Local no-login services must remain loopback-only.
