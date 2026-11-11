import { Kysely, PostgresDialect, sql, type ColumnType, type Generated } from "kysely";
import { Pool } from "pg";
import type {
  AssetType,
  ConnectorStatus,
  DataSourceType,
  EventMappingStatus,
  EventMappingValidationError,
  ExternalIdentifier,
  JsonObject,
  RestSyncRecordError,
  RestPaginationConfiguration,
  RestSyncRunStatus,
} from "@kudu/shared";

type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string | undefined>;

export type StoredSourceConfiguration =
  | {
      kind: "rest_api";
      baseUrl: string;
      endpointPath?: string;
      method?: "GET";
      authMode?: "none" | "bearer";
      credentialRef?: string;
      trustedPrivateHost?: string;
      queryParameters?: Record<string, string>;
      sourceTimezone?: string;
      timeoutMs?: number;
      maxResponseBytes?: number;
      maxRecords?: number;
      responseFormat?: "json";
      recordsPath?: string;
      pagination?: RestPaginationConfiguration;
    }
  | { kind: "json_file"; relativePath: string; recordsPath?: string; sourceTimezone?: string }
  | { kind: "csv_file"; relativePath: string; sourceTimezone?: string }
  | { kind: "manual" };

interface AssetsTable {
  id: Generated<string>;
  asset_key: string;
  name: string;
  asset_type: AssetType;
  description: string | null;
  parent_asset_id: string | null;
  external_identifiers: ColumnType<ExternalIdentifier[], string, string>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
  archived_at: Date | null;
}

interface DataSourcesTable {
  id: Generated<string>;
  source_key: string;
  display_name: string;
  source_type: DataSourceType;
  description: string | null;
  configuration: ColumnType<StoredSourceConfiguration, string, string>;
  enabled: boolean;
  connection_status: Generated<ConnectorStatus>;
  ingestion_status: Generated<ConnectorStatus>;
  last_successful_sync_at: Date | null;
  last_error_summary: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

interface EventsTable {
  id: Generated<string>;
  source_id: string;
  asset_id: string | null;
  source_record_id: string | null;
  event_type: string;
  occurred_at: TimestampColumn;
  ingested_at: Generated<Date>;
  source_timestamp: string;
  deduplication_key: string | null;
  ingestion_fingerprint: string | null;
  payload: ColumnType<JsonObject, string, string>;
  provenance: ColumnType<JsonObject, string, string>;
}

interface SourceRecordsTable {
  id: Generated<string>;
  source_id: string;
  source_record_id: string | null;
  deduplication_key: string;
  ingestion_fingerprint: string;
  raw_record: ColumnType<JsonObject, string, string>;
  raw_bytes: number;
  field_count: number;
  field_names: ColumnType<string[], string, string>;
  preview: ColumnType<Record<string, string>, string, string>;
  provenance: ColumnType<JsonObject, string, string>;
  processing_status: "raw_only" | "normalized";
  normalized_event_id: string | null;
  sync_run_id: string | null;
  mapping_version: number | null;
  ingested_at: TimestampColumn;
}

interface DataSourceEventMappingsTable {
  id: Generated<string>;
  source_id: string;
  version: number;
  status: EventMappingStatus;
  definition: ColumnType<JsonObject, string, string>;
  validation_errors: ColumnType<EventMappingValidationError[], string, string>;
  validated_at: Date | null;
  activated_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface DataSourceSyncRunsTable {
  id: Generated<string>;
  source_id: string;
  mapping_version: number;
  status: RestSyncRunStatus;
  resumable: boolean;
  request_succeeded: boolean;
  config_fingerprint: string;
  checkpoint: ColumnType<JsonObject, string, string>;
  pages_completed: number;
  fetched: number;
  imported: number;
  duplicates: number;
  failed: number;
  errors: ColumnType<RestSyncRecordError[], string, string>;
  errors_truncated: boolean;
  last_error_code: string | null;
  started_at: TimestampColumn;
  updated_at: TimestampColumn;
  completed_at: TimestampColumn | null;
}

interface SourceSyncRunsTable extends Omit<DataSourceSyncRunsTable, "mapping_version"> {
  mapping_version: number | null;
}

export interface Database {
  assets: AssetsTable;
  data_sources: DataSourcesTable;
  events: EventsTable;
  source_records: SourceRecordsTable;
  data_source_event_mappings: DataSourceEventMappingsTable;
  data_source_sync_runs: DataSourceSyncRunsTable;
  source_sync_runs: SourceSyncRunsTable;
}

export function createDatabase(connectionString: string): {
  db: Kysely<Database>;
  close: () => Promise<void>;
} {
  const pool = new Pool({
    connectionString,
    max: 10,
    application_name: "kudu-api",
    options: "-c search_path=kudu,public",
  });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
  return {
    db,
    close: async () => {
      await db.destroy();
    },
  };
}

export async function checkDatabase(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
