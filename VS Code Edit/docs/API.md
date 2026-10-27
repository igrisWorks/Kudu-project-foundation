# API

The versioned API provides health checks and persistent asset and data-source registries. The complete OpenAPI 3.1 description is in [`openapi.yaml`](openapi.yaml).

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

## Registry routes

All registry routes are under `/api/v1`. List responses use `{ "items": [], "total": 0, "page": 1, "pageSize": 25 }`; page numbers start at 1 and `pageSize` is limited to 1–100. Search is case-insensitive and limited to 120 characters. Results have stable key/name and ID ordering.

### Assets

| Method | Route | Behavior |
|---|---|---|
| `GET` | `/api/v1/assets` | Search and list assets. Optional `search`, `page`, `pageSize`, and `status=active\|archived\|all` (default `active`). |
| `POST` | `/api/v1/assets` | Create an asset; returns `201` with its detail and child list. |
| `GET` | `/api/v1/assets/{id}` | Get an asset, parent summary, external identifiers, and child summaries. |
| `PATCH` | `/api/v1/assets/{id}` | Update supplied fields. `parentAssetId: null` removes a parent; `description: null` clears it; `archived: true/false` archives or restores. |

Asset keys are unique without regard to case. Parent links must point to an active asset and cannot create a cycle. The database prevents deletion of a referenced parent; the API does not expose a destructive delete route.

Example:

```json
{
  "assetKey": "line-01",
  "name": "Packaging line 01",
  "assetType": "production_line",
  "description": "Primary packaging line",
  "externalIdentifiers": [
    { "sourceKey": "erp", "externalId": "PL-001" }
  ]
}
```

### Data sources

| Method | Route | Behavior |
|---|---|---|
| `GET` | `/api/v1/data-sources` | Search and list sources. Optional `search`, `page`, `pageSize`, `sourceType`, and `enabled=all\|enabled\|disabled`. |
| `POST` | `/api/v1/data-sources` | Register source metadata; returns `201`. Does not connect or ingest. |
| `GET` | `/api/v1/data-sources/{id}` | Get metadata and redacted configuration status. |
| `PATCH` | `/api/v1/data-sources/{id}` | Update supplied metadata. Changing source type requires matching configuration. |

Supported source types are `rest_api`, `json_file`, `csv_file`, and `manual`. REST configuration accepts an HTTP(S) base URL without credentials, query parameters, or fragments. An optional credential reference must have the form `env:KUDU_SOURCE_NAME`; the API stores only the reference and returns only `credentialConfigured`, never the reference or secret value. The referenced variable must be provisioned out of band. File paths must be relative; the API does not open them. All connection and ingestion statuses remain `not_implemented`, and registering or enabling a source never starts outbound traffic.

Example:

```json
{
  "sourceKey": "erp",
  "displayName": "ERP API",
  "sourceType": "rest_api",
  "configuration": {
    "kind": "rest_api",
    "baseUrl": "https://erp.example.test/api",
    "credentialRef": "env:KUDU_SOURCE_ERP_TOKEN"
  }
}
```

### Errors and security

Errors use `{ "error": { "code": "...", "message": "...", "fields": {} } }`; `fields` is omitted when there are no field-specific errors. Duplicate keys return `409`; validation failures return `400`; missing records return `404`.

Authentication and authorization are not implemented. All write routes are unauthenticated. The default server host is `127.0.0.1`, and the Compose app port is published on loopback only. Do not override these controls or expose the service to untrusted networks until authentication and authorization are added.
