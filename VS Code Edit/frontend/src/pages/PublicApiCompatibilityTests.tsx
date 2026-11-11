import { useRef, useState } from "react";
import { Link } from "wouter";
import type { DataSourceRecord, JsonObject } from "@kudu/shared";
import {
  createDataSource,
  discoverDataSource,
  downloadExplorerRecords,
  getExplorerRecord,
  listExplorerRecords,
  syncRestDataSource,
} from "../api";
import { JsonPlaceholderPreview, OpenMeteoPreview, UsgsFeaturePreview } from "./PublicApiTestPreviews";
import {
  csvDataRowCount,
  errorCategory,
  initialEndpoint,
  jsonPlaceholderEndpoints,
  publicApiTests,
  requestConfiguration,
  safeEndpoint,
  type ApiTestId,
  type ApiTestState,
  type PublicApiTest,
} from "./publicApiTestConfig";

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
export default function PublicApiCompatibilityTests() {
  const [states, setStates] = useState<Partial<Record<ApiTestId, ApiTestState>>>({});
  const [selectedEndpoints, setSelectedEndpoints] = useState<Record<ApiTestId, string>>(initialEndpoint);
  const [selectedMeasurements, setSelectedMeasurements] = useState<Partial<Record<ApiTestId, string>>>({ openmeteo: "" });
  const [busy, setBusy] = useState(false);
  const [runAllSummary, setRunAllSummary] = useState<string[]>([]);
  const busyRef = useRef(false);
  const updateState = (id: ApiTestId, update: Partial<ApiTestState>) => {
    setStates(current => ({ ...current, [id]: { ...current[id], ...update } }));
  };

  const getConnectionResult = async (test: PublicApiTest, endpointPath: string) => {
    const result = await discoverDataSource("rest_api", requestConfiguration(test, endpointPath), test.recordPath);
    if (result.selectedRecordPath !== test.recordPath) {
      throw new Error("The documented top-level API response could not be selected for inspection.");
    }
    return result;
  };

  const checkConnection = async (test: PublicApiTest) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const endpointPath = selectedEndpoints[test.id] ?? test.endpointPath;
    setStates(current => ({
      ...current,
      [test.id]: { status: "connecting", message: "Sending one bounded, read-only GET through KuduNS discovery…" },
    }));
    try {
      const discovery = await getConnectionResult(test, endpointPath);
      updateState(test.id, {
        status: "passed",
        message: "Connection and bounded discovery succeeded. No source or records were created.",
        discovery,
        fieldsDetected: discovery.fields.length,
        errorCode: undefined,
        category: undefined,
      });
    } catch (error) {
      const failure = errorCategory(error);
      updateState(test.id, { status: "failed", message: failure.message, category: failure.category, errorCode: failure.code });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const runIngestion = async (test: PublicApiTest, endpointPath = selectedEndpoints[test.id] ?? test.endpointPath): Promise<boolean> => {
    let source: DataSourceRecord | undefined;
    setStates(current => ({
      ...current,
      [test.id]: {
        status: "running",
        message: "Testing discovery, then creating an isolated source and running the normal REST sync pipeline…",
      },
    }));
    try {
      const discovery = await getConnectionResult(test, endpointPath);
      const config = requestConfiguration(test, endpointPath);
      const nonce = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 10) ??
        `${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`;
      const sourceKey = `public_test_${test.id}_${nonce}`.slice(0, 80);
      source = await createDataSource({
        sourceKey,
        displayName: `Public API test · ${test.name} · ${nonce}`,
        sourceType: "rest_api",
        description: "Created by the operator-run API Compatibility Tests. This source and its imported history are retained; repeated runs create a separate source.",
        configuration: {
          ...config,
          ...(discovery.selectedRecordPath && discovery.selectedRecordPath !== "$"
            ? { recordsPath: discovery.selectedRecordPath }
            : {}),
        },
        enabled: true,
      });
      updateState(test.id, { discovery, source });

      const sync = await syncRestDataSource(source.id);
      if (!sync.requestSucceeded || sync.status !== "completed") {
        const firstError = sync.errors[0];
        const error = new Error(firstError?.message ?? `REST sync finished with status ${sync.status}.`);
        Object.assign(error, { code: firstError?.code ?? "REST_SYNC_FAILED" });
        throw error;
      }

      const firstPage = await listExplorerRecords({ sourceId: source.id, page: 1, pageSize: 100, sortBy: "ingestedAt", sortDirection: "asc" });
      const recordSummaries = [...firstPage.items];
      const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
      for (let page = 2; page <= pageCount; page += 1) {
        const next = await listExplorerRecords({ sourceId: source.id, page, pageSize: firstPage.pageSize, sortBy: "ingestedAt", sortDirection: "asc" });
        recordSummaries.push(...next.items);
      }
      if (recordSummaries.some(record => record.source.id !== source!.id)) {
        throw new Error("The Explorer result included a record from another source.");
      }
      const firstRecord = recordSummaries[0] ? await getExplorerRecord(recordSummaries[0].id) : undefined;
      const firstPreview = recordSummaries[0]?.preview ?? {};
      const searchTerm = Object.values(firstPreview).find(value =>
        value && value !== "null" && value !== "Object" && !value.startsWith("Array"),
      )?.slice(0, 48) ?? source.sourceKey;
      const search = await listExplorerRecords({
        sourceId: source.id,
        search: searchTerm,
        page: 1,
        pageSize: 20,
        sortBy: "ingestedAt",
        sortDirection: "asc",
      });
      if (firstRecord && search.total < 1) throw new Error("Explorer search did not find the known first stored record.");

      const exportQuery = { sourceId: source.id, page: 1, pageSize: 100 };
      const [jsonBlob, csvBlob] = await Promise.all([
        downloadExplorerRecords("json", exportQuery),
        downloadExplorerRecords("csv", exportQuery),
      ]);
      const jsonExport = JSON.parse(await jsonBlob.text()) as {
        total: number;
        items: Array<{ source: { id: string }; rawRecord: JsonObject }>;
      };
      const csvText = await csvBlob.text();
      const csvCount = csvDataRowCount(csvText);
      if (jsonExport.total !== firstPage.total || jsonExport.items.length !== firstPage.total) {
        throw new Error("JSON export count did not match the stored source-record count.");
      }
      if (csvCount !== firstPage.total) throw new Error("CSV export count did not match the stored source-record count.");
      if (jsonExport.items.some(item => item.source.id !== source!.id)) {
        throw new Error("The source-scoped export included a record from another source.");
      }
      if (firstRecord && JSON.stringify(jsonExport.items[0]?.rawRecord) !== JSON.stringify(firstRecord.rawRecord)) {
        throw new Error("The JSON export did not preserve the first stored raw record.");
      }
      const features = test.id === "usgs" && firstRecord && Array.isArray(firstRecord.rawRecord.features)
        ? firstRecord.rawRecord.features.length
        : undefined;
      const hourly = test.id === "openmeteo" ? objectValue(firstRecord?.rawRecord.hourly) : null;
      const measurements = Array.isArray(hourly?.time) ? hourly.time.length : undefined;
      const normalizedCount = recordSummaries.filter(record => record.processingStatus === "normalized").length;
      if (normalizedCount !== 0) throw new Error("The public test source unexpectedly created normalized events.");
      const rawOnlyCount = recordSummaries.filter(record => record.processingStatus === "raw_only").length;
      if (rawOnlyCount !== recordSummaries.length) throw new Error("The public test source included a record that was not raw-only.");
      updateState(test.id, {
        status: "passed",
        message: "KuduNS discovery, raw ingestion, source-scoped exploration/search, JSON export, and CSV export all passed.",
        discovery,
        source,
        records: recordSummaries,
        rawRecord: firstRecord?.rawRecord,
        sourceRecordCount: firstPage.total,
        fetched: sync.fetched,
        imported: sync.imported,
        rawOnly: rawOnlyCount,
        duplicates: sync.duplicates,
        failed: sync.failed,
        features,
        measurements,
        fieldsDetected: discovery.fields.length,
        searchTerm,
        searchMatches: search.total,
        jsonExportCount: jsonExport.items.length,
        csvExportCount: csvCount,
        testedEndpoint: endpointPath,
      });
      return true;
    } catch (error) {
      const failure = errorCategory(error);
      updateState(test.id, {
        status: "failed",
        message: failure.message,
        category: failure.category,
        errorCode: failure.code,
        ...(source ? { source } : {}),
      });
      return false;
    }
  };

  const runOne = async (test: PublicApiTest) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await runIngestion(test, selectedEndpoints[test.id] ?? test.endpointPath);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const runAll = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRunAllSummary([]);
    try {
      const results: string[] = [];
      const plan = [
        ...jsonPlaceholderEndpoints.map(endpoint => ({
          test: publicApiTests[0]!,
          endpointPath: endpoint.path,
          label: `JSONPlaceholder ${endpoint.path}`,
        })),
        ...publicApiTests.slice(1).map(test => ({
          test,
          endpointPath: test.endpointPath,
          label: test.name,
        })),
      ];
      for (const entry of plan) {
        const passed = await runIngestion(entry.test, entry.endpointPath);
        results.push(`${passed ? "Passed" : "Failed"}: ${entry.label}`);
        setRunAllSummary([...results]);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return <div className="api-compatibility" data-testid="panel-public-api-tests">
    <div className="api-compatibility-intro">
      <div>
        <span className="section-label">ON-DEMAND · READ-ONLY GET</span>
        <p>Each connection check uses KuduNS bounded discovery. An ingestion test creates a uniquely named source, runs the existing raw-first REST sync, then checks Explorer, search, and exports. Results and imported history are retained in your database; every repeated ingestion test creates another independent source.</p>
      </div>
      <button className="button button-primary" type="button" onClick={() => void runAll()} disabled={busy} data-testid="button-run-all-api-tests">
        {busy ? "Test sequence running…" : "Run all API tests"}
      </button>
    </div>
    {runAllSummary.length > 0 && <div className="api-run-all-summary" role="status" data-testid="summary-run-all-api-tests">
      {runAllSummary.map((result, index) => <span key={`${index}-${result}`}>{result}</span>)}
    </div>}
    <div className="api-test-cards">
      {publicApiTests.map(test => {
        const state = states[test.id] ?? { status: "idle" as const };
        const endpointPath = selectedEndpoints[test.id] ?? test.endpointPath;
        return <article className="api-test-card" key={test.id} data-testid={`card-api-test-${test.id}`}>
          <header className="api-test-card-header">
            <div><span className="api-test-label">PUBLIC API · GET ONLY</span><h3>{test.name}</h3></div>
            <span className={`api-test-status api-test-status-${state.status}`} data-testid={`status-api-test-${test.id}`}>{state.status.replace("-", " ")}</span>
          </header>
          <p className="api-test-purpose">{test.purpose}</p>
          {test.id === "jsonplaceholder" && <label className="api-test-field"><span>Endpoint</span>
            <select value={endpointPath} onChange={event => setSelectedEndpoints(current => ({ ...current, [test.id]: event.target.value }))} disabled={busy} data-testid="select-jsonplaceholder-endpoint">
              {jsonPlaceholderEndpoints.map(endpoint => <option value={endpoint.path} key={endpoint.path}>{endpoint.label}</option>)}
            </select>
          </label>}
          <div className="api-test-endpoint"><span>ENDPOINT</span><code data-testid={`text-api-endpoint-${test.id}`}>{safeEndpoint(test, endpointPath)}</code></div>
          {test.sourceTimezone && <p className="api-test-timezone">Explicit source time zone: <strong>{test.sourceTimezone}</strong></p>}
          <div className="api-test-actions">
            <button type="button" className="button" onClick={() => void checkConnection(test)} disabled={busy} data-testid={`button-test-connection-${test.id}`}>Test connection</button>
            <button type="button" className="button button-primary" onClick={() => void runOne(test)} disabled={busy} data-testid={`button-run-ingestion-${test.id}`}>Run ingestion test</button>
          </div>
          {state.message && <div className={`api-test-result ${state.status === "failed" ? "error" : ""}`} role={state.status === "failed" ? "alert" : "status"} data-testid={`result-api-test-${test.id}`}>
            <strong>{state.message}</strong>
            {state.testedEndpoint && <span>Tested endpoint: <code>{state.testedEndpoint}</code></span>}
            {state.category && <span>{state.category} · {state.errorCode}</span>}
            {state.discovery && <span>{state.discovery.recordPaths.reduce((sum, path) => sum + path.recordCount, 0)} discovered record/response candidates · {state.discovery.fields.length} fields · {state.discovery.sampledPageCount} sampled page(s)</span>}
            {state.source && <span>Source: <Link href={`/data-sources/${encodeURIComponent(state.source.id)}`} data-testid={`link-api-test-source-${test.id}`}>{state.source.displayName}</Link> · <code>{state.source.sourceKey}</code></span>}
          </div>}
          {(state.status === "passed" || state.status === "failed") && state.source && <div className="api-test-metrics" data-testid={`metrics-api-test-${test.id}`}>
            <div><strong>{state.fetched ?? 0}</strong><span>fetched</span></div>
            <div><strong>{state.imported ?? 0}</strong><span>new raw records</span></div>
            <div><strong>{state.rawOnly ?? "—"}</strong><span>records retained raw-only</span></div>
            <div><strong>{state.fieldsDetected ?? state.discovery?.fields.length ?? 0}</strong><span>fields detected</span></div>
            <div><strong>{state.sourceRecordCount ?? "—"}</strong><span>Explorer records</span></div>
            <div><strong>{state.duplicates ?? "—"}</strong><span>duplicates</span></div>
            <div><strong>{state.failed ?? "—"}</strong><span>failed records</span></div>
            {state.features !== undefined && <div><strong>{state.features}</strong><span>GeoJSON features in raw document</span></div>}
            {state.measurements !== undefined && <div><strong>{state.measurements}</strong><span>aligned hourly points</span></div>}
            {state.searchTerm && <div><strong>{state.searchMatches ?? 0}</strong><span>search matches for “{state.searchTerm}”</span></div>}
            {state.jsonExportCount !== undefined && <div><strong>{state.jsonExportCount}</strong><span>JSON rows exported</span></div>}
            {state.csvExportCount !== undefined && <div><strong>{state.csvExportCount}</strong><span>CSV rows exported</span></div>}
          </div>}
          {state.status === "passed" && state.source && <div className="api-test-links">
            <Link href={`/data-explorer?sourceId=${encodeURIComponent(state.source.id)}`} data-testid={`link-api-test-explorer-${test.id}`}>Explore this source</Link>
            <Link href={`/visualisations?sourceId=${encodeURIComponent(state.source.id)}`} data-testid={`link-api-test-visualisations-${test.id}`}>Visualise this source</Link>
            <a href={test.documentationUrl} target="_blank" rel="noreferrer">API documentation</a>
          </div>}
          {state.status === "passed" && state.rawRecord && test.id === "openmeteo" && <OpenMeteoPreview
            rawRecord={state.rawRecord}
            selectedField={selectedMeasurements.openmeteo ?? ""}
            onSelectField={path => setSelectedMeasurements(current => ({ ...current, openmeteo: path }))}
          />}
          {state.status === "passed" && state.rawRecord && test.id === "usgs" && <UsgsFeaturePreview rawRecord={state.rawRecord} />}
          {state.status === "passed" && test.id === "jsonplaceholder" && state.records && <JsonPlaceholderPreview records={state.records} />}
          {state.status === "passed" && state.discovery && <details className="api-test-discovery" data-testid={`details-api-discovery-${test.id}`}>
            <summary>Discovered fields and source structures</summary>
            <ul>{state.discovery.fields.map(field => <li key={field.path}><code>{field.path}</code><span>{field.valueType}</span></li>)}</ul>
            {state.discovery.structures.length > 0 && <p>Nested structures: {state.discovery.structures.map(structure => `${structure.path} (${structure.kind})`).join(" · ")}</p>}
          </details>}
        </article>;
      })}
    </div>
    <p className="api-test-footnote">Tests run only after an operator chooses a button; there is no background polling. Test sources are never matched to or overwritten by name. Archive a test source through normal source management if you no longer want to use it; its imported history remains retained.</p>
  </div>;
}
