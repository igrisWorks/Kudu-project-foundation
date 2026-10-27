import { Kysely, PostgresDialect, sql, type ColumnType, type Generated } from "kysely";
import { Pool } from "pg";
import type {
  AssetType,
  ConnectorStatus,
  DataSourceType,
  ExternalIdentifier,
} from "@kudu/shared";

type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string | undefined>;

export type StoredSourceConfiguration =
  | { kind: "rest_api"; baseUrl: string; credentialRef?: string }
  | { kind: "json_file"; relativePath: string }
  | { kind: "csv_file"; relativePath: string }
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

export interface Database {
  assets: AssetsTable;
  data_sources: DataSourcesTable;
}

export function createDatabase(connectionString: string): {
  db: Kysely<Database>;
  close: () => Promise<void>;
} {
  const pool = new Pool({
    connectionString,
    max: 10,
    application_name: "kudu-api",
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
