export interface HealthResponse {
  status: "ok" | "degraded";
  database: "connected" | "unavailable";
  checkedAt: string;
}

export interface AuthSessionResponse {
  configured: boolean;
  authenticated: boolean;
  localMode?: boolean;
  localDocker?: boolean;
  expiresAt?: string;
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
export type RestApiAuthMode = "none" | "bearer";

export interface RestPaginationConfiguration {
  strategy: "offset" | "page" | "cursor";
  pageSize: number;
  limitParameter: string;
  requestIntervalMs?: number;
  startOffset?: number;
  startPage?: number;
  offsetParameter?: string;
  pageParameter?: string;
  cursorParameter?: string;
  nextCursorPath?: string;
  dateFromParameter?: string;
  dateFrom?: string;
  dateToParameter?: string;
  dateTo?: string;
}

export type DataSourceConfigurationInput =
  | {
      kind: "rest_api";
      baseUrl: string;
      endpointPath?: string;
      method?: "GET";
      authMode?: RestApiAuthMode;
      credentialRef?: string | null;
      timeoutMs?: number;
      maxResponseBytes?: number;
      maxRecords?: number;
      responseFormat?: "json";
      recordsPath?: string;
      pagination?: RestPaginationConfiguration;
    }
  | { kind: "json_file"; relativePath: string; recordsPath?: string }
  | { kind: "csv_file"; relativePath: string }
  | { kind: "manual" };

export type DataSourceConfigurationMetadata =
  | {
      kind: "rest_api";
      baseUrl: string;
      credentialConfigured: boolean;
      endpointPath?: string;
      method?: "GET";
      authMode?: RestApiAuthMode;
      timeoutMs?: number;
      maxResponseBytes?: number;
      maxRecords?: number;
      responseFormat?: "json";
      recordsPath?: string;
      pagination?: RestPaginationConfiguration;
    }
  | { kind: "json_file"; relativePath: string; recordsPath?: string }
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

export type DiscoveredValueType = "string" | "number" | "boolean" | "datetime" | "object" | "array" | "mixed" | "unknown";
export type MappingConfidence = "high" | "medium" | "low";
export type SuggestedTargetField = "eventType" | "occurredAt" | "sourceRecordId" | "assetKey" | "message" | "severity" | "errorCode";

export interface DiscoveredField {
  path: string;
  valueType: DiscoveredValueType;
  examples: string[];
}

export interface DiscoveryRecordPath {
  path: string;
  recordCount: number;
  supported: boolean;
}

export interface SuggestedFieldMapping {
  target: SuggestedTargetField;
  sourcePath: string | null;
  confidence: MappingConfidence;
  confidenceScore: number;
  required: boolean;
  ambiguous: boolean;
  alternatives: string[];
  examples: string[];
  note: string;
}

export interface DiscoveryAssetMatch {
  status: "matched" | "unmatched" | "ambiguous";
  confidence: number;
  matchType?: "asset_key" | "registered_external_identifier" | "name_suggestion";
}

export interface DiscoveryPreviewRecord {
  recordNumber: number;
  state: "valid" | "warning" | "rejected";
  issues: string[];
  values: Record<string, string>;
  normalized: Record<string, string>;
  assetMatch?: DiscoveryAssetMatch;
}

export interface DataSourceDiscoveryResult {
  sourceType: "rest_api" | "json_file" | "csv_file";
  sampledPageCount: number;
  recordPaths: DiscoveryRecordPath[];
  selectedRecordPath: string | null;
  fields: DiscoveredField[];
  suggestions: SuggestedFieldMapping[];
  preview: DiscoveryPreviewRecord[];
  warnings: string[];
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

export interface FileImportRecordError {
  record: number;
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export interface FileImportResult {
  sourceId: string;
  format: "csv" | "json";
  records: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: FileImportRecordError[];
  errorsTruncated: boolean;
}

export type EventMappingStatus = "draft" | "active" | "retired";

export interface EventMappingDefinition {
  eventType?: string;
  occurredAt?: string;
  sourceRecordId?: string;
  assetKey?: string;
  payload?: Record<string, string>;
}

export interface EventMappingValidationError {
  field: string;
  message: string;
}

export interface DataSourceEventMapping {
  id: string;
  sourceId: string;
  version: number;
  status: EventMappingStatus;
  definition: JsonObject;
  validationErrors: EventMappingValidationError[];
  validatedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventMappingValidationResult {
  valid: boolean;
  errors: EventMappingValidationError[];
}

export interface DataSourceEventMappingsResponse {
  items: DataSourceEventMapping[];
}

export interface RestSyncRecordError {
  record: number;
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export type RestSyncRunStatus = "running" | "completed" | "paused" | "failed";

export interface RestSyncResult {
  runId: string;
  sourceId: string;
  mappingVersion: number;
  status: RestSyncRunStatus;
  requestSucceeded: boolean;
  pagesCompleted: number;
  fetched: number;
  imported: number;
  duplicates: number;
  failed: number;
  errors: RestSyncRecordError[];
  errorsTruncated: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  resumable: boolean;
}

export interface RestSyncRunsResponse {
  items: RestSyncResult[];
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
