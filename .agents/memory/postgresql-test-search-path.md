---
name: PostgreSQL test search path
description: Keep direct PostgreSQL integration-test connections consistent with the runtime schema lookup behavior.
---

Kudu PostgreSQL integration-test pools that issue unqualified table queries must use the same schema search path as runtime connections. Migration-only tests can remain schema-qualified.

**Why:** A disposable non-superuser database run produced a misleading relation-not-found failure because a registry test pool omitted the runtime schema lookup path. Matching the runtime pool made the migration and API integration tests pass without changing application database behavior.

**How to apply:** When adding a direct PostgreSQL test pool, reuse runtime connection options or explicitly match its schema search path. Keep migration-only SQL schema-qualified when that is clearer.
