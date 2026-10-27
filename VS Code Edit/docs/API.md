# API

The initial API is intentionally limited to process and database health.

## `GET /healthz`

Liveness probe. Returns `200` with `{"status":"ok"}` while the HTTP process is accepting requests. It does not claim the database is ready.

## `GET /api/v1/health`

Readiness probe. Executes a lightweight database query.

Healthy response (`200`):

```json
{
  "status": "ok",
  "database": "connected",
  "checkedAt": "2026-10-27T12:00:00.000Z"
}
```

Database unavailable response (`503`):

```json
{
  "status": "degraded",
  "database": "unavailable",
  "checkedAt": "2026-10-27T12:00:00.000Z"
}
```

`checkedAt` is UTC. This endpoint intentionally does not include connection details or error messages. Shared response types are maintained in `shared/src/index.ts`.

No business-data endpoints exist yet. Future routes belong under `/api/v1`, require explicit request validation, and must be documented here when introduced.
