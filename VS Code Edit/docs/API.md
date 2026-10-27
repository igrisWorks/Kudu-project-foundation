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

### Events

| Method | Route | Behavior |
|---|---|---|
| `POST` | `/api/v1/events` | Validate and persist an event with source provenance; first insert returns `201`, an identical deduplicated retry returns `200`. |
| `GET` | `/api/v1/events` | List event metadata with stable pagination and optional filters. Payloads are omitted from list rows. |
| `GET` | `/api/v1/events/{id}` | Get the full event, payload, and provenance. |

Ingestion requires a registered `sourceId`, event type, RFC 3339 `occurredAt` with an explicit timezone, and a JSON-object `payload`. `assetId`, original source record ID, original source timestamp, source provenance object, and deduplication key are optional. Asset and source references are checked before insertion. The complete payload is stored without filtering unknown fields; payload and provenance together are limited to 512 KiB.

`occurredAt` is stored as a PostgreSQL `timestamptz` and returned in UTC. The exact submitted timestamp is retained as `sourceTimestamp` unless a separate source timestamp is provided. This preserves original offsets or source-specific timestamp text. `ingestedAt` is assigned by PostgreSQL.

Deduplication keys are unique per data source. Repeating the same key with identical event content returns the existing event with `duplicate: true`; reusing it with different content returns `409 DEDUPLICATION_CONFLICT`. Requests without a deduplication key are always inserted as new events. The key is scoped to the source so unrelated sources can use the same source-record key.

List filters are `sourceId`, `assetId`, exact case-insensitive `sourceKey` and `assetKey`, exact `eventType`, and inclusive RFC 3339 `from`/`to` timestamps. Events are ordered by occurrence time descending, then ID descending. `pageSize` defaults to 25 and is limited to 100.

Example:

```json
{
  "sourceId": "9a07ab8c-2f6e-46e1-88e7-d8a754e9351f",
  "assetId": "2edccf7c-68ef-4d15-bbbe-a18640a87231",
  "sourceRecordId": "controller-event-019",
  "eventType": "alarm.raised",
  "occurredAt": "2026-10-27T16:15:30.123456+02:00",
  "deduplicationKey": "controller-event-019",
  "payload": {
    "alarm": { "code": "E-19", "severity": 3 },
    "vendorSpecificField": { "value": "preserved" }
  },
  "provenance": {
    "controller": "press-02",
    "signal": "high_pressure"
  }
}
```

### Errors and security

Errors use `{ "error": { "code": "...", "message": "...", "fields": {} } }`; `fields` is omitted when there are no field-specific errors. Duplicate registry keys and conflicting event deduplication-key reuse return `409`; validation failures return `400`; missing records return `404`. An identical event retry returns the original record with `200`.

Authentication and authorization are not implemented. All write routes are unauthenticated. The default server host is `127.0.0.1`, and the Compose app port is published on loopback only. Do not override these controls or expose the service to untrusted networks until authentication and authorization are added.
