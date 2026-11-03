---
name: Disposable PostgreSQL test lifecycle
description: How to keep a temporary local PostgreSQL cluster alive for integration tests in this workspace.
---

Start the temporary cluster and run its integration tests inside the same managed background shell. A PostgreSQL server started by a foreground shell command may be terminated when that command exits, even if `pg_ctl` reported a successful start.

**Why:** the workspace ended the `pg_ctl` child process when a foreground shell invocation ended; running cluster setup and tests in one managed background process kept the disposable database available.

**How to apply:** use a unique `/tmp` data directory, bind only to loopback, run the tests while that shell remains active, then stop PostgreSQL and remove only that temporary directory in cleanup.
