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

## Authentication

`GET /healthz`, `GET /api/v1/health`, and `GET /api/v1/auth/session` are public. `POST /api/v1/auth/login` accepts a password and sets an opaque session cookie. All other `/api/v1` routes require that session and the `X-Kudu-CSRF` header matching the same-site CSRF cookie, including sensitive reads, writes, event ingestion, file import, source discovery, and REST sync. `POST /api/v1/auth/logout` revokes the current session.

The login response does not include the session or CSRF token in JSON. The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` by default; the separate CSRF cookie is same-site and required alongside the header for every protected API request. Sessions expire after 8 hours and are held in memory, so restarting Kudu invalidates them. There is one shared operator password and no roles.

When `KUDU_AUTH_PASSWORD_HASH` or a valid `SESSION_SECRET` is missing, private API routes fail closed with `503 AUTH_NOT_CONFIGURED`; health checks remain available. Invalid login attempts are rate-limited to 5 per source IP and 30 globally per 15-minute window, with at most two concurrent password checks. Configure the hash and session secret as protected environment values; never commit them or place the password in a command-line argument.

### Local Web Edition only

When `KUDU_LOCAL_MODE=true` is explicitly set outside production and the backend binds to loopback, the session endpoint reports `{ "configured": true, "authenticated": true, "localMode": true }`; the ordinary dashboard does not require operator sign-in. This mode is not a supported remote-access configuration. API requests are restricted to loopback peers/Host values, and state-changing requests must carry a same-local-origin browser `Origin`.

The local database settings API is registered only in this mode:

| Method | Route | Behavior |
|---|---|---|
| `GET` | `/api/v1/local/database` | Return sanitized connection metadata and current connection/migration status. No password is returned. |
| `POST` | `/api/v1/local/database/test` | Verify the submitted loopback PostgreSQL connection without saving or migrating. |
| `POST` | `/api/v1/local/database/save` | Verify credentials and least-privilege role, apply forward migrations, securely persist settings, and switch the live pool. |
| `POST` | `/api/v1/local/database/initialize` | With explicit confirmation, create only a missing database and/or role using a one-request administrator credential. Existing role passwords and database contents are not reset. |
| `POST` | `/api/v1/local/database/migrate` | Apply pending forward-only migrations to the active connection. |

These routes are intentionally absent in the authenticated edition. Password fields are redacted from server request logs, use backend-side persistence, and are excluded from API responses.

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
| `POST` | `/api/v1/data-sources/discover` | Explicitly inspect one REST, JSON, or CSV source and return candidate collections, field suggestions, and a bounded preview. |

Supported source types are `rest_api`, `json_file`, `csv_file`, and `manual`. REST configuration accepts an HTTP(S) base URL without credentials, query parameters, or fragments, plus a relative endpoint path. Only `GET` and JSON responses are supported. Configure the JSON records path (a dot path or blank for a top-level array), timeout, response-size limit, and record-count limit (up to 100,000 records across a run). Pagination is opt-in; when configured, choose the source API's offset, page-number, or cursor convention, page size, query parameter names, optional date bounds, and request interval.

Authentication is either `none` or `bearer`. Bearer authentication requires HTTPS and an environment-variable reference such as `env:KUDU_SOURCE_ERP_TOKEN`. The referenced variable must be provisioned out of band. The API returns only whether a reference is configured; it never returns the reference or secret value. A reference from an older registry version is inactive unless `authMode` is `bearer`.

Registration, editing, viewing, and listing never make outbound requests or read files. `Discover` is a separate operator action: it sends one bounded REST `GET` or reads the registered relative file, but does not ingest events, create assets, or activate mappings. REST discovery and sync both use the existing destination validation and authentication rules.

Example:

```json
{
  "sourceKey": "erp",
  "displayName": "ERP API",
  "sourceType": "rest_api",
  "configuration": {
    "kind": "rest_api",
    "baseUrl": "https://erp.example.test/api",
    "endpointPath": "v1/events",
    "method": "GET",
    "authMode": "bearer",
    "credentialRef": "env:KUDU_SOURCE_ERP_TOKEN",
    "timeoutMs": 10000,
    "maxResponseBytes": 1048576,
    "maxRecords": 500,
    "responseFormat": "json",
    "recordsPath": "data.events"
  }
}
```

### On-demand discovery

The discovery request takes a supported `sourceType`, the same validated configuration used when registering the source, and an optional `recordPath` previously returned by discovery. REST discovery sends one bounded `GET` (the configured first-page limit may be applied); it does not page through historical data. JSON and CSV sources are read beneath `KUDU_IMPORT_DIRECTORY` with the existing file-size, path, and symlink protections. No recurring polling is performed.

The response reports candidate record arrays (including nested arrays within JSON objects), sample field paths and inferred types, examples, confidence-ranked mapping suggestions, ambiguities, a proposed normalized preview, and validation issues. Sensitive-looking field values are hidden in examples. If multiple record collections are found, an operator must select one. The UI allows changing or excluding each field suggestion. Saving an accepted suggestion creates or updates a versioned draft only; an operator must validate and explicitly activate it. Unmapped source fields remain in event payloads and provenance.

Example request:

```json
{
  "sourceType": "rest_api",
  "configuration": {
    "kind": "rest_api",
    "baseUrl": "https://faults.example.test/api",
    "endpointPath": "faults",
    "method": "GET",
    "authMode": "none",
    "maxResponseBytes": 1048576,
    "maxRecords": 500
  }
}
```

### REST API sync

| Method | Route | Behavior |
|---|---|---|
| `POST` | `/api/v1/data-sources/{id}/sync` | Fetch and ingest records from one enabled REST source. The request has no body and accepts no URL or method override. |
| `GET` | `/api/v1/data-sources/{id}/sync-runs` | Return the latest 25 stored run summaries, errors, and resumability flags. |
| `POST` | `/api/v1/data-sources/{id}/sync-runs/{runId}/resume` | Explicitly resume a paused or retryable run when the active mapping and pagination configuration are unchanged. |

Sync requires an active event mapping. The configured endpoint is formed from the base URL and relative endpoint path, uses `GET` only, and parses the configured JSON array. The collection path selected during discovery is saved in source configuration. Each object record is normalized by the same versioned mapping and submitted through normal event ingestion and source-scoped deduplication. ISO/date strings and Unix epoch seconds or milliseconds are accepted for mapped occurrence times; original timestamp text is retained as `sourceTimestamp`.

When pagination is configured, each explicit sync action processes at most three pages and commits event records and the next-page checkpoint before returning. Offset, page-number, and cursor checkpoints are supported. A partial batch or record-limit boundary is resumable; use the explicit resume route. A retryable transport error may also be resumed. Changing the collection path, pagination settings, or active mapping version blocks resume and requires a new run. The run result reports its ID, mapping version, status, page count, fetched/imported/duplicate/failed counts, request success, and up to 100 sanitized errors. The server honors `Retry-After` for HTTP 429/5xx responses within the configured timeout, retries bounded transient failures, and applies the configured minimum interval between pages. It never schedules or polls a source. Cursor tokens and raw checkpoints are not returned by the API. Increasing `maxRecords` is allowed when resuming; the pagination and mapping fingerprint remains fixed.

Without pagination configured, one bounded response is processed as a single page. A response larger than `maxRecords` is rejected rather than partially imported. Runs are stored in the same SQLite Local or PostgreSQL Server/Enterprise database as their events. Event provenance includes the run ID and mapping version.

Example remote response and mapping:

```json
{
  "data": {
    "events": [
      {
        "id": "controller-019",
        "kind": "alarm.raised",
        "time": "2026-10-27T16:15:30.123456+02:00",
        "machine_key": "press-02",
        "measurements": { "pressure_kpa": 842.5 }
      }
    ]
  }
}
```

Use an active mapping such as `eventType: "kind"`, `occurredAt: "time"`, `sourceRecordId: "id"`, `assetKey: "machine_key"`, and `payload: { "pressureKpa": "measurements.pressure_kpa" }`. The original record and mapping version are retained in provenance, the source record ID is retained in the event, and original timestamp text is retained as `sourceTimestamp`. Without a mapped source-record ID, a stable hash of the JSON record is used as the deduplication key.

### REST destination security

Public IPv4/IPv6 destinations are allowed by default. Loopback, private, link-local, multicast, reserved, and other special-use addresses are blocked. DNS answers are checked and the connection is pinned to a validated address. Each redirect is checked again, redirects are bounded, HTTPS-to-HTTP downgrade is blocked, and bearer credentials are never forwarded to another origin.

For trusted on-premises APIs, configure `KUDU_REST_TRUSTED_HOSTS` as a comma-separated list of exact hostnames or IP addresses, such as `plc-api.internal,10.20.30.40`. Only listed hosts may resolve to private IPv4 or IPv6 ULA addresses. Wildcards are not supported; loopback, link-local, multicast, and reserved addresses remain blocked. Configure this allowlist only on a trusted host. Kudu's business API requires an authenticated session; retain loopback binding and TLS at any reverse proxy.

### CSV/JSON file import

| Method | Route | Behavior |
|---|---|---|
| `POST` | `/api/v1/data-sources/{id}/import` | Import the file already configured on an enabled CSV or JSON source. The request has no body and accepts no filesystem path. |

The route reads the source's registered `configuration.relativePath` beneath `KUDU_IMPORT_DIRECTORY`. Absolute paths, traversal segments, and symlinks escaping that directory are rejected. The configured extension must match the source type (`.csv` for `csv_file`, `.json` for `json_file`). REST API and manual sources are not importable. Disabled sources return `409`. An alternate nested JSON `recordsPath` requires an active event mapping; without one, the legacy top-level-array parser and payload rules are preserved.

The default local import directory is `imports/` at the project root. In Docker Compose, the host directory defaults to `./imports` and is mounted read-only at `/imports`. Configure `KUDU_IMPORT_DIRECTORY` for direct local runs, and `KUDU_IMPORT_HOST_DIRECTORY` to change the Compose host directory.

Files must be UTF-8, no larger than 5 MiB, and contain at most 1,000 records. Without an active mapping, CSV files require headers `eventType`, `occurredAt`, and `payload`; optional headers are `assetId` and `sourceRecordId`. The `payload` cell is a JSON object (or blank for an empty object). Other columns are preserved as string fields inside the event payload; a field that collides with a payload key fails that record. With an active mapping, any unique, non-empty headers are allowed and the `payload` column is optional. Quoted CSV fields support commas, newlines, and escaped quotes.

```csv
eventType,occurredAt,sourceRecordId,payload,station
alarm.raised,2026-10-27T12:00:00Z,row-001,"{""code"":""E-7""}",press-2
```

JSON files contain an array of event objects with the same default fields, or an object with a nested record array selected by the optional `recordsPath` dot path. Nested paths are imported only after an active mapping is explicitly reviewed and activated. Without an active mapping, the legacy top-level-array parser remains unchanged: unknown top-level keys in each record are merged into `payload`; duplicate keys between those fields and `payload` fail the record instead of overwriting data. An active mapping may read selected fields directly from the source object and does not require a `payload` object.

```json
[
  {
    "eventType": "alarm.raised",
    "occurredAt": "2026-10-27T12:00:00Z",
    "sourceRecordId": "row-001",
    "payload": { "code": "E-7" },
    "station": "press-2"
  }
]
```

Each valid record is sent through the normal event validation, reference checks, and source-scoped deduplication path. `sourceRecordId` is used as the deduplication key when present. Otherwise, the key is derived from the configured relative path and CSV line or JSON array position, making an unchanged repeat import deterministic. A duplicate increments `skipped`; invalid records and conflicting key reuse increment `failed`. The response reports `records`, `imported`, `skipped`, and `failed`, plus up to 100 record/line errors. Results are returned per request; import history is not stored.

### Versioned event mappings

| Method | Route | Behavior |
|---|---|---|
| `GET` | `/api/v1/data-sources/{id}/mappings` | Inspect mapping versions and their draft/active/retired status. |
| `POST` | `/api/v1/data-sources/{id}/mappings` | Create the next draft version. Only one draft per source is allowed. |
| `PUT` | `/api/v1/data-sources/{id}/mappings/{version}` | Replace a draft definition; this clears prior validation. |
| `POST` | `/api/v1/data-sources/{id}/mappings/{version}/validate` | Validate the definition and save any errors. |
| `POST` | `/api/v1/data-sources/{id}/mappings/{version}/activate` | Activate a validated draft and retire the previously active version. |

Mappings are available for registered CSV, JSON, and REST API sources. A definition selects source field paths for required event type and occurrence timestamp, optional source-record ID and asset key, and optional payload output fields. Nested JSON paths use dot notation; array indexing and arbitrary value transformations are not supported. Discovery accepts supported Unix epoch seconds and milliseconds for occurrence timestamps.

```json
{
  "definition": {
    "eventType": "kind",
    "occurredAt": "metadata.time",
    "sourceRecordId": "record_id",
    "assetKey": "machine_key",
    "payload": {
      "temperatureC": "measurements.temp_c"
    }
  }
}
```

The `assetKey` rule first resolves an exact active `asset_key`, then a unique external identifier explicitly registered for that source. These deterministic matches may associate the event. If neither matches, an exact name match is recorded only as a suggestion; ambiguous matches remain unattached. No asset is created automatically. Event provenance records the source identifier, match status, confidence, and any suggested or matched asset ID so an operator can correct the registry before a later import. Each mapped import or REST sync stores the mapping version and original source record in event provenance. The occurrence time is normalized to UTC by event ingestion while its original text is retained as `sourceTimestamp`. Unmapped fields remain in payload; mapped payload outputs are added without silently overwriting different existing values. Missing required mapped fields are reported during import or sync.

Activation changes interpretation only for subsequent imports and REST syncs. Existing events are not rewritten. Mapping version is retained in provenance, and source-scoped deduplication remains in effect: reusing a source-record ID with changed normalized content is a conflict, not an update. If no mapping is active, existing CSV/JSON import behavior is unchanged; REST sync requires an active mapping. Mapping writes require the authenticated session and CSRF header.

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

The default server host is `127.0.0.1`, and the Compose app port is published on loopback only. Health endpoints remain public; registry, event, import, mapping, and sync routes require an authenticated session. Do not expose the service over an untrusted network without TLS and an appropriately configured reverse proxy.
