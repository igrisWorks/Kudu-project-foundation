export interface HealthResponse {
  status: "ok" | "degraded";
  database: "connected" | "unavailable";
  checkedAt: string;
}

export const ASSET_TYPES = [
  "machine",
  "production_line",
  "plc",
  "camera",
  "sensor",
  "other",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];
export type AssetStatus = "active" | "archived";

export interface ExternalIdentifier {
  sourceKey: string;
  externalId: string;
}

export interface AssetParentSummary {
  id: string;
  assetKey: string;
  name: string;
}

export interface AssetRecord {
  id: string;
  assetKey: string;
  name: string;
  assetType: AssetType;
  description: string | null;
  parentAssetId: string | null;
  parentAsset: AssetParentSummary | null;
  externalIdentifiers: ExternalIdentifier[];
  status: AssetStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AssetChildSummary {
  id: string;
  assetKey: string;
  name: string;
  assetType: AssetType;
}

export interface AssetDetail extends AssetRecord {
  children: AssetChildSummary[];
}

export interface AssetCreateInput {
  assetKey: string;
  name: string;
  assetType: AssetType;
  description?: string | null;
  parentAssetId?: string | null;
  externalIdentifiers?: ExternalIdentifier[];
}

export interface AssetUpdateInput {
  assetKey?: string;
  name?: string;
  assetType?: AssetType;
  description?: string | null;
  parentAssetId?: string | null;
  externalIdentifiers?: ExternalIdentifier[];
  archived?: boolean;
}

export const DATA_SOURCE_TYPES = [
  "rest_api",
  "json_file",
  "csv_file",
  "manual",
] as const;

export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];
export type ConnectorStatus = "not_implemented" | "connected" | "error" | "unsupported";
export type DataSourceEnabledFilter = "all" | "enabled" | "disabled";

export type DataSourceConfigurationInput =
  | {
      kind: "rest_api";
      baseUrl: string;
      credentialRef?: string | null;
    }
  | { kind: "json_file"; relativePath: string }
  | { kind: "csv_file"; relativePath: string }
  | { kind: "manual" };

export type DataSourceConfigurationMetadata =
  | {
      kind: "rest_api";
      baseUrl: string;
      credentialConfigured: boolean;
    }
  | { kind: "json_file"; relativePath: string }
  | { kind: "csv_file"; relativePath: string }
  | { kind: "manual"; referenceOnly: true };

export interface DataSourceRecord {
  id: string;
  sourceKey: string;
  displayName: string;
  sourceType: DataSourceType;
  description: string | null;
  configuration: DataSourceConfigurationMetadata;
  enabled: boolean;
  connectionStatus: ConnectorStatus;
  ingestionStatus: ConnectorStatus;
  lastSuccessfulSyncAt: string | null;
  lastErrorSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataSourceCreateInput {
  sourceKey: string;
  displayName: string;
  sourceType: DataSourceType;
  description?: string | null;
  configuration: DataSourceConfigurationInput;
  enabled?: boolean;
}

export interface DataSourceUpdateInput {
  sourceKey?: string;
  displayName?: string;
  sourceType?: DataSourceType;
  description?: string | null;
  configuration?: DataSourceConfigurationInput;
  enabled?: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type AssetStatusFilter = "active" | "archived" | "all";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface EventSourceReference {
  id: string;
  sourceKey: string;
  displayName: string;
}

export interface EventAssetReference {
  id: string;
  assetKey: string;
  name: string;
}

export interface EventListItem {
  id: string;
  source: EventSourceReference;
  asset: EventAssetReference | null;
  sourceRecordId: string | null;
  eventType: string;
  occurredAt: string;
  ingestedAt: string;
  sourceTimestamp: string;
  deduplicationKey: string | null;
}

export interface EventDetail extends EventListItem {
  payload: JsonObject;
  provenance: JsonObject;
}

export interface IngestEventInput {
  sourceId: string;
  assetId?: string | null;
  sourceRecordId?: string | null;
  eventType: string;
  occurredAt: string;
  sourceTimestamp?: string | null;
  deduplicationKey?: string | null;
  payload: JsonObject;
  provenance?: JsonObject;
}

export interface IngestEventResponse {
  event: EventDetail;
  duplicate: boolean;
}

export interface EventListFilters {
  sourceId?: string;
  assetId?: string;
  sourceKey?: string;
  assetKey?: string;
  eventType?: string;
  from?: string;
  to?: string;
}
