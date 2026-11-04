---
name: SQLite migration line endings
description: Cross-platform line-ending behavior for immutable Local SQLite migration checksums.
---

Local SQLite migration checksums must not treat LF and CRLF representations of the same SQL as different schema versions. Store new hashes from LF-normalized SQL and accept hashes for exact, LF, or CRLF bytes only; continue rejecting all other content changes.

**Why:** Windows checkout line endings can differ from the LF bytes committed in Git, causing a safe existing database to fail startup even though its migration SQL is unchanged.

**How to apply:** Preserve already-applied migration files. When updating SQLite migration validation, allow only line-ending equivalence and keep tests that confirm actual SQL edits still fail without altering data.
