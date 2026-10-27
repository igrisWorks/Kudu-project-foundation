import { createHash } from "node:crypto";
import type {
  EventDetail,
  EventListItem,
  EventSourceReference,
  EventAssetReference,
  IngestEventResponse,
  JsonObject,
  Page,
} from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";
import { ApiFailure } from "./errors.js";
import { canonicalJson, validateEventIngest, validateEventListFilters } from "./event-validation.js";

interface EventJoinRow {
  id: string;
  source_id: string;
  source_key: string;
  source_display_name: string;
  asset_id: string | null;
  asset_key: string | null;
  asset_name: string | null;
  source_record_id: string | null;
  event_type: string;
  occurred_at: string;
  ingested_at: Date;
  source_timestamp: string;
  deduplication_key: string | null;
}

interface EventDetailJoinRow extends EventJoinRow {
  payload: JsonObject;
  provenance: JsonObject;
}

const eventListProjection = [
  "e.id as id",
  "e.source_id as source_id",
  "s.source_key as source_key",
  "s.display_name as source_display_name",
  "e.asset_id as asset_id",
  "a.asset_key as asset_key",
  "a.name as asset_name",
  "e.source_record_id as source_record_id",
  "e.event_type as event_type",
  sql<string>`to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("occurred_at"),
  "e.ingested_at as ingested_at",
  "e.source_timestamp as source_timestamp",
  "e.deduplication_key as deduplication_key",
] as const;

const eventDetailProjection = [
  ...eventListProjection,
  "e.payload as payload",
  "e.provenance as provenance",
] as const;

function toEventListItem(row: EventJoinRow): EventListItem {
  const source: EventSourceReference = {
    id: row.source_id,
    sourceKey: row.source_key,
    displayName: row.source_display_name,
  };
  const asset: EventAssetReference | null =
    row.asset_id === null
      ? null
      : {
          id: row.asset_id,
          assetKey: row.asset_key ?? "",
          name: row.asset_name ?? "",
        };
  return {
    id: row.id,
    source,
    asset,
    sourceRecordId: row.source_record_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at.toISOString(),
    sourceTimestamp: row.source_timestamp,
    deduplicationKey: row.deduplication_key,
  };
}

function toEventDetail(row: EventDetailJoinRow): EventDetail {
  return {
    ...toEventListItem(row),
    payload: row.payload,
    provenance: row.provenance,
  };
}

async function getEventDetail(db: Kysely<Database>, id: string): Promise<EventDetail> {
  const row = await db
    .selectFrom("events as e")
    .innerJoin("data_sources as s", "s.id", "e.source_id")
    .leftJoin("assets as a", "a.id", "e.asset_id")
    .select(eventDetailProjection)
    .where("e.id", "=", id)
    .executeTakeFirst();
  if (!row) throw new ApiFailure(404, "NOT_FOUND", "Event not found.");
  return toEventDetail(row as EventDetailJoinRow);
}

async function listEvents(db: Kysely<Database>, query: unknown): Promise<Page<EventListItem>> {
  const filters = validateEventListFilters(query);
  let rowsQuery = db
    .selectFrom("events as e")
    .innerJoin("data_sources as s", "s.id", "e.source_id")
    .leftJoin("assets as a", "a.id", "e.asset_id")
    .select(eventListProjection);
  let countQuery = db
    .selectFrom("events as e")
    .innerJoin("data_sources as s", "s.id", "e.source_id")
    .leftJoin("assets as a", "a.id", "e.asset_id")
    .select((eb) => eb.fn.countAll<number>().as("total"));

  if (filters.sourceId) {
    rowsQuery = rowsQuery.where("e.source_id", "=", filters.sourceId);
    countQuery = countQuery.where("e.source_id", "=", filters.sourceId);
  }
  if (filters.assetId) {
    rowsQuery = rowsQuery.where("e.asset_id", "=", filters.assetId);
    countQuery = countQuery.where("e.asset_id", "=", filters.assetId);
  }
  if (filters.sourceKey) {
    rowsQuery = rowsQuery.where("s.source_key", "ilike", filters.sourceKey);
    countQuery = countQuery.where("s.source_key", "ilike", filters.sourceKey);
  }
  if (filters.assetKey) {
    rowsQuery = rowsQuery.where("a.asset_key", "ilike", filters.assetKey);
    countQuery = countQuery.where("a.asset_key", "ilike", filters.assetKey);
  }
  if (filters.eventType) {
    rowsQuery = rowsQuery.where("e.event_type", "=", filters.eventType);
    countQuery = countQuery.where("e.event_type", "=", filters.eventType);
  }
  if (filters.from) {
    rowsQuery = rowsQuery.where(sql<boolean>`e.occurred_at >= ${filters.from}::timestamptz`);
    countQuery = countQuery.where(sql<boolean>`e.occurred_at >= ${filters.from}::timestamptz`);
  }
  if (filters.to) {
    rowsQuery = rowsQuery.where(sql<boolean>`e.occurred_at <= ${filters.to}::timestamptz`);
    countQuery = countQuery.where(sql<boolean>`e.occurred_at <= ${filters.to}::timestamptz`);
  }

  const [rows, total] = await Promise.all([
    rowsQuery
      .orderBy("e.occurred_at", "desc")
      .orderBy("e.id", "desc")
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize)
      .execute(),
    countQuery.executeTakeFirstOrThrow(),
  ]);
  return {
    items: rows.map((row) => toEventListItem(row as EventJoinRow)),
    total: Number(total.total),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

function fingerprint(input: ReturnType<typeof validateEventIngest>): string {
  const stableRecord = {
    sourceId: input.sourceId,
    assetId: input.assetId,
    sourceRecordId: input.sourceRecordId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    sourceTimestamp: input.sourceTimestamp,
    payload: input.payload,
    provenance: input.provenance,
  };
  return createHash("sha256").update(canonicalJson(stableRecord)).digest("hex");
}

async function ingestEvent(
  db: Kysely<Database>,
  rawInput: unknown,
): Promise<IngestEventResponse> {
  const input = validateEventIngest(rawInput);
  const contentFingerprint = fingerprint(input);
  const inserted = await db.transaction().execute(async (transaction) => {
    const source = await transaction
      .selectFrom("data_sources")
      .select("id")
      .where("id", "=", input.sourceId)
      .executeTakeFirst();
    if (!source) {
      throw new ApiFailure(400, "INVALID_REFERENCE", "The registered data source was not found.", {
        sourceId: "Choose a registered data source.",
      });
    }
    if (input.assetId) {
      const asset = await transaction
        .selectFrom("assets")
        .select("id")
        .where("id", "=", input.assetId)
        .executeTakeFirst();
      if (!asset) {
        throw new ApiFailure(400, "INVALID_REFERENCE", "The registered asset was not found.", {
          assetId: "Choose a registered asset or omit this field.",
        });
      }
    }

    const result = await sql<{ id: string }>`
      INSERT INTO kudu.events (
        source_id,
        asset_id,
        source_record_id,
        event_type,
        occurred_at,
        source_timestamp,
        deduplication_key,
        ingestion_fingerprint,
        payload,
        provenance
      )
      VALUES (
        ${input.sourceId},
        ${input.assetId},
        ${input.sourceRecordId},
        ${input.eventType},
        ${input.occurredAt},
        ${input.sourceTimestamp},
        ${input.deduplicationKey},
        ${input.deduplicationKey ? contentFingerprint : null},
        ${JSON.stringify(input.payload)}::jsonb,
        ${JSON.stringify(input.provenance)}::jsonb
      )
      ON CONFLICT (source_id, deduplication_key)
        WHERE deduplication_key IS NOT NULL
        DO NOTHING
      RETURNING id
    `.execute(transaction);
    if (result.rows[0]) return { id: result.rows[0].id, duplicate: false };

    const existing = await transaction
      .selectFrom("events")
      .select(["id", "ingestion_fingerprint"])
      .where("source_id", "=", input.sourceId)
      .where("deduplication_key", "=", input.deduplicationKey!)
      .executeTakeFirst();
    if (!existing) {
      throw new Error("Event deduplication conflict did not resolve to an existing event.");
    }
    if (existing.ingestion_fingerprint !== contentFingerprint) {
      throw new ApiFailure(
        409,
        "DEDUPLICATION_CONFLICT",
        "This deduplication key is already used for different event content.",
      );
    }
    return { id: existing.id, duplicate: true };
  });

  return {
    event: await getEventDetail(db, inserted.id),
    duplicate: inserted.duplicate,
  };
}

export function registerEventRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.post("/api/v1/events", async (request, reply) => {
    const result = await ingestEvent(db, request.body);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get("/api/v1/events", async (request) => listEvents(db, request.query));

  app.get<{ Params: { id: string } }>("/api/v1/events/:id", async (request) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.id)) {
      throw new ApiFailure(400, "INVALID_ID", "A valid event identifier is required.");
    }
    return getEventDetail(db, request.params.id);
  });
}
