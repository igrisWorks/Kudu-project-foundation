import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import "./help-page.css";

type HelpArticle = {
  id: string;
  title: string;
  searchText: string;
  content: ReactNode;
};

type HelpSection = {
  id: string;
  label: string;
  title: string;
  description: string;
  articles: HelpArticle[];
};

type TutorialStep = {
  title: string;
  copy: string;
  href?: string;
  linkLabel?: string;
};

type Tutorial = {
  id: string;
  title: string;
  steps: TutorialStep[];
};

type TutorialProgress = {
  tutorialIndex: number;
  stepIndex: number;
  completed: boolean;
};

const PROGRESS_KEY = "kuduns.help-tutorial-progress.v1";

const sections: HelpSection[] = [
  {
    id: "start-here",
    label: "Start here",
    title: "A safe path from source to useful data",
    description: "KuduNS keeps source access explicit. Registration, discovery, import, and event mapping are separate operator decisions.",
    articles: [
      {
        id: "welcome",
        title: "Welcome to KuduNS",
        searchText: "welcome getting started overview operator on premises source records events",
        content: <>
          <p>KuduNS is an on-premises workspace for describing industrial data sources, inspecting their records, and optionally preparing records as events. Start with a source you are authorized to access and keep each action deliberate.</p>
          <ol><li>Register a source and review its configuration.</li><li>Discover a bounded sample of fields, then inspect the result.</li><li>Choose whether to import or sync; create and activate a mapping only if normalized events are useful.</li></ol>
          <div className="help-callout"><strong>Nothing runs just because a source is registered or enabled.</strong> Source discovery, REST sync, and local file import are initiated by an operator.</div>
          <p>Original source payloads remain available in Data Explorer even when a record has no event mapping or is not normalized.</p>
          <Link className="help-inline-link" href="/data-sources" data-testid="link-help-data-sources">Open data sources</Link>
        </>,
      },
      {
        id: "getting-started",
        title: "Get started without sending an unexpected request",
        searchText: "getting started setup workflow connection test discover inspect import sync",
        content: <>
          <p>Use this order for a new connection: identify the endpoint or local file, add source metadata, save configuration, and review it before discovery. Saving configuration does not contact the source.</p>
          <ul><li>For REST, set the base URL, endpoint path, response format, optional authentication reference, query parameters, and any required pagination settings.</li><li>Use bounded discovery to check a configured source. Discovery is limited; it is not a full import. Fixed public API checks are available in the Help page below.</li><li>Review fields and records before choosing an import or sync action.</li></ul>
          <div className="help-callout caution">REST requests are read-only, on-demand bounded GET requests. KuduNS does not poll a remote API or run scheduled ingestion.</div>
          <Link className="help-inline-link" href="/data-sources/new" data-testid="link-help-create-source">Register a data source</Link>
        </>,
      },
      {
        id: "rest-get",
        title: "Configure a REST source and test it explicitly",
        searchText: "rest api get setup endpoint url authentication bearer credential connection test",
        content: <>
          <p>Configure the exact host and endpoint path provided by the system owner. KuduNS REST sources use GET only. Provide a response format and, for JSON, the records path when the records are not a top-level array.</p>
          <ul><li>Use the configured bearer-token environment reference only when the endpoint requires it; do not paste credentials into help or share them in screenshots.</li><li>Review timeout, maximum response size, record limit, and pagination settings. A paginated action is bounded and allows up to three pages per action.</li><li>Save, then select the explicit connection test or discovery action. A saved or enabled source does not make a request on its own.</li></ul>
          <p>Bounded discovery checks the configured endpoint and retrieves a sample for field review. Use Sync now only after reviewing what the source will return. The Help page compatibility panel tests only its listed public endpoints.</p>
          <Link className="help-inline-link" href="/data-sources/new" data-testid="link-help-rest-setup">Open source setup</Link>
        </>,
      },
      {
        id: "discovery-import",
        title: "Keep discovery, mapping, and ingestion separate",
        searchText: "bounded discovery field review operator controlled import sync mapping activate",
        content: <>
          <p>Discovery is an explicit, bounded request. It helps identify record paths and observed fields; it does not import records, create assets, or activate an event mapping.</p>
          <ol><li>Review the chosen collection and observed field names, types, and examples.</li><li>Optionally draft a mapping, validate it, and activate it only after checking the field paths and meaning.</li><li>When ready, start the configured local file import or REST sync with its explicit operator action.</li></ol>
          <p>REST sync and JSON/CSV file imports are on demand. Registration and enabling a source do not schedule or start ingestion.</p>
          <Link className="help-inline-link" href="/data-sources" data-testid="link-help-discovery-sources">Review source records</Link>
        </>,
      },
      {
        id: "raw-vs-events",
        title: "Source records and normalized events are different views",
        searchText: "raw records original payload optional normalization event mapping raw only events",
        content: <>
          <p>Source records show the data as it was imported from its source, including the original payload. Normalized events are an optional, mapped view with event fields such as event type and occurrence time.</p>
          <p>A record can remain raw-only when no mapping is active or normalization is not applicable. Creating a draft mapping does not activate it. Mapping and event views do not replace the original source payload or invent mappings and assets.</p>
          <div className="help-callout">Choose Source records to inspect what arrived. Choose Normalized events when an approved active mapping has produced events you want to query.</div>
          <Link className="help-inline-link" href="/data-explorer" data-testid="link-help-explorer-raw-events">Open Data Explorer</Link>
        </>,
      },
    ],
  },
  {
    id: "inspect-data",
    label: "Inspect data",
    title: "Read the source shape before interpreting it",
    description: "Search, filter, inspect nested payloads, and distinguish what is present from what is missing.",
    articles: [
      {
        id: "explorer-search",
        title: "Search and filter in Data Explorer",
        searchText: "data explorer search filter source records events source scope sort time",
        content: <>
          <p>Data Explorer has separate Source records and Normalized events modes. Search and source scope apply to the selected mode. Record search can match record identifiers, source keys, or source content; event search covers source record, event type, or payload.</p>
          <ul><li>Use the source selector to narrow results to one registered source, or leave it at All sources.</li><li>In the event view, filter by event type and occurrence-time range. Results are paginated; check the displayed total and current page.</li><li>Use sorting to make review repeatable. Changing filters returns the view to the first page.</li></ul>
          <p>Explorer displays actual stored records and reports loading or request errors separately; it does not create data for empty results.</p>
          <Link className="help-inline-link" href="/data-explorer" data-testid="link-help-open-explorer">Open Data Explorer</Link>
        </>,
      },
      {
        id: "nested-json",
        title: "Inspect nested JSON objects and arrays",
        searchText: "json nested objects arrays path tree expand field discovery records path",
        content: <>
          <p>Expand an object or array in a source record to inspect its children. Object keys appear as paths such as <code>machine.state</code>; array entries use an index such as <code>alarms[0].code</code>. Large groups are shown in pages.</p>
          <p>Discovery can report candidate record paths and observed nested fields, but its suggestions are advisory. Confirm the actual path and values in the original record before using a path in a mapping or visualization.</p>
          <p>A text cell that contains JSON may be expandable as a decoded structure while the original cell text remains visible. A cell that is not JSON stays a scalar value.</p>
          <div className="help-callout caution">Do not assume every record has the same shape. A field can be absent, null, or a different type in other records.</div>
          <Link className="help-inline-link" href="/data-explorer" data-testid="link-help-nested-json">Inspect source records</Link>
        </>,
      },
      {
        id: "missing-null",
        title: "Understand missing, null, and blank values",
        searchText: "missing null empty blank field absent payload value data quality",
        content: <>
          <p><strong>Missing</strong> means the field is not present at the inspected path. <strong>null</strong> is an explicit value in the payload. Blank text is a string with no visible characters. These are not interchangeable.</p>
          <p>Compare the original record and the exact field path. The preview may say “Not present in preview” when a field was not returned for that record; a present null is rendered as <code>null</code>. Discovery examples are sampled observations, not a guarantee for every record.</p>
          <p>Before mapping or charting a field, inspect several records and decide how the source’s variation should be handled.</p>
        </>,
      },
      {
        id: "multiple-sources",
        title: "Work with multiple sources without mixing their meaning",
        searchText: "multiple sources source scope combine fields records source key source identity",
        content: <>
          <p>Each source has its own identity and configuration. Use the Data Explorer source filter to review one source at a time or compare records across sources. Cross-source fields are identified with the source display name and source key because identical field names may have different meanings.</p>
          <p>Do not assume matching field names represent the same unit, clock, or state vocabulary. Confirm each source’s payload and mapping independently. Visualizations retain the selected source scope.</p>
          <Link className="help-inline-link" href="/data-sources" data-testid="link-help-multiple-sources">Manage sources</Link>
        </>,
      },
    ],
  },
  {
    id: "visualise-export",
    label: "Visualise & export",
    title: "Turn inspected records into a view or a file",
    description: "Visualisations can use raw records or imported events; exports follow the selected data mode and filters.",
    articles: [
      {
        id: "visualisations",
        title: "Visualize original records or imported events",
        searchText: "visualization visualisation raw record imported event time series frequency state distribution",
        content: <>
          <p>Visualisations offer two distinct modes. Raw-record visualisations read original imported record payloads. Event visualisations query persisted normalized events. Choose the mode that matches the question you are asking.</p>
          <ul><li>Frequency views count observed values from a selected field in the loaded raw-record set.</li><li>Time-series views require a timestamp field and numeric value field. The selected fields are not inferred as a validated measurement model.</li><li>State or category distributions count values in a chosen category field. Inspect the source values before interpreting the result.</li></ul>
          <p>Event visualisations work from loaded imported events, select an event type and exact payload path, and can render time-series, category, distribution, or table views. A chart can be empty if loaded records lack usable values for the selected field.</p>
          <Link className="help-inline-link" href="/visualisations" data-testid="link-help-visualisations">Open Visualisations</Link>
        </>,
      },
      {
        id: "saved-views",
        title: "Save and reopen a visualisation",
        searchText: "save reopen saved views browser local storage configuration view",
        content: <>
          <p>Name a configured view and select Save visualisation. Saved definitions are stored in this browser profile; they retain the query and field choices, not copies of raw payloads or event records. Reopening a view reads the data again from KuduNS.</p>
          <p>Use the saved-view list to reopen a definition. If its source, event type, or selected field is no longer available, review the configuration and choose an available path. Removing a saved view removes its local definition, not source data.</p>
          <Link className="help-inline-link" href="/visualisations" data-testid="link-help-saved-views">Open saved views</Link>
        </>,
      },
      {
        id: "export-formats",
        title: "Export JSON, CSV, or XLSX",
        searchText: "export json csv xlsx download original records events current filters",
        content: <>
          <p>Data Explorer exports source records or normalized events according to the active mode and query filters. Choose JSON, CSV, or XLSX from the export controls. Review the selected source, search, time range, and event type before downloading.</p>
          <p>Use the source-record export when you need the original record payloads. Event export is the normalized event view. A selected-field CSV, where available, is a preview of the current page rather than a substitute for exporting the full query.</p>
          <p>Exports are generated by the KuduNS service; if a download fails, note the active mode and filters, retry once, and consult the error or server operator.</p>
          <Link className="help-inline-link" href="/data-explorer" data-testid="link-help-export">Open export controls</Link>
        </>,
      },
    ],
  },
  {
    id: "troubleshooting",
    label: "Troubleshooting",
    title: "Diagnose the boundary before changing configuration",
    description: "Use the failure point and returned error as evidence. Avoid widening access or limits until you know what failed.",
    articles: [
      {
        id: "connection-refused",
        title: "REST connection refused",
        searchText: "troubleshooting connection refused REST endpoint firewall port network",
        content: <>
          <p>Connection refused usually means the configured host was reached but no service accepted the connection at that address and port. Verify the scheme, host, port, endpoint service, and the KuduNS server’s network route with your system operator.</p>
          <p>Check that the remote service is listening and that firewall rules permit the intended connection. Retry the explicit test after confirming the endpoint. Do not broaden firewall access or add a new trust exception without approval.</p>
        </>,
      },
      {
        id: "dns-failure",
        title: "The REST host cannot be resolved",
        searchText: "troubleshooting DNS host resolve name resolution rest api",
        content: <>
          <p>Check the host spelling and whether the name resolves from the machine running KuduNS, not only from your workstation. On-premises DNS search domains and split-horizon records can differ between clients.</p>
          <p>Ask the network or DNS owner to verify the intended record and resolver path. Use an approved host name or address in the source configuration; do not substitute an unrelated public endpoint.</p>
        </>,
      },
      {
        id: "http-auth-errors",
        title: "HTTP status or authentication error",
        searchText: "troubleshooting HTTP 401 403 404 5xx auth bearer token credentials",
        content: <>
          <p>For 401 or 403, verify the endpoint’s required authentication mode, token environment reference, token availability to the KuduNS service, and required permissions. Never expose a token in a support request.</p>
          <p>For 404, confirm the base URL and endpoint path with the API owner. For other HTTP errors, read the returned status and message and check the remote service logs with its operator. A connection test does not import records.</p>
        </>,
      },
      {
        id: "empty-response",
        title: "A successful request returns no records",
        searchText: "troubleshooting empty response zero records no data JSON array records path",
        content: <>
          <p>Inspect the response format and records path. The configured path must identify the array or record collection actually returned by the endpoint. A response with an empty array may also be valid for the selected query or time range.</p>
          <p>Use bounded discovery and review its record-path observations. Check server-side filters and permissions with the API owner. Do not repeatedly sync an endpoint while troubleshooting an empty response.</p>
        </>,
      },
      {
        id: "nested-json-trouble",
        title: "Nested JSON or arrays do not appear as expected",
        searchText: "troubleshooting nested JSON arrays records path collection field path",
        content: <>
          <p>Confirm that the selected records path points to the collection, then expand objects and arrays in a source record to see the exact nested path. Array entries include an index; a field may be inside each item rather than on the parent object.</p>
          <p>Discovery is a bounded sample and may not include every variant. Review more than one original record before editing a mapping or visualization field.</p>
        </>,
      },
      {
        id: "unsupported-format",
        title: "The local file format is unsupported",
        searchText: "troubleshooting unsupported file format local import JSON CSV XLSX",
        content: <>
          <p>Local file imports support JSON and CSV. XLSX is an Explorer export format, not a local source-import format. Check that the registered file source type matches the actual file and that its configured relative path points to a file in the configured local import directory.</p>
          <p>For JSON, check the response shape and records path. For CSV, check the header row and delimiter/encoding expected by the importer. If the file is not valid JSON or CSV, prepare an approved supported file rather than renaming its extension.</p>
        </>,
      },
      {
        id: "timezone-dst",
        title: "Timestamps, time zones, and daylight-saving changes",
        searchText: "troubleshooting timezone UTC DST daylight saving explicit timezone ambiguous time",
        content: <>
          <p>KuduNS does not infer a source time zone. Confirm what the source timestamp means and whether it includes an offset or UTC marker. Provide an explicit time zone or offset in the source or upstream process where needed.</p>
          <p>Local event time filters are converted by the browser to an absolute time for the request. Daylight-saving transitions can make a local wall-clock time ambiguous or nonexistent; verify the intended offset and UTC interval with the system owner before interpreting results. Displayed event times use UTC.</p>
          <div className="help-callout caution">Do not treat an offset-free timestamp as UTC unless the source owner explicitly documents that behavior.</div>
        </>,
      },
      {
        id: "export-trouble",
        title: "An export fails or does not contain what you expected",
        searchText: "troubleshooting export failed JSON CSV XLSX download filters permissions",
        content: <>
          <p>Confirm the selected mode (Source records or Normalized events), source scope, search text, event type, date range, and result page context. The selected-field CSV is limited to the current displayed page; use the main export action for a query export.</p>
          <p>If the service returns an error, retry after confirming connectivity and access. If it persists, note the format and filters and ask the KuduNS operator to check server logs. Avoid sharing exported operational data unless authorized.</p>
        </>,
      },
    ],
  },
];

const tutorials: Tutorial[] = [
  { id: "first-source", title: "Connect your first source", steps: [
    { title: "Choose an authorized source", copy: "Confirm the source owner, its intended data, and whether it is a remote REST endpoint or a local JSON/CSV file. KuduNS does not discover sources on its own.", href: "/data-sources", linkLabel: "Open data sources" },
    { title: "Register its connection details", copy: "Create a source record and enter its key, display name, type, and configuration. Saving stores the definition; it does not connect, import, or start a schedule.", href: "/data-sources/new", linkLabel: "Add a data source" },
    { title: "Review before the first request", copy: "Read the saved configuration and limits. Use bounded discovery next, and only import or sync after reviewing what was found.", href: "/data-sources", linkLabel: "Review sources" },
  ] },
  { id: "configure-rest", title: "Configure a REST endpoint", steps: [
    { title: "Enter the exact endpoint", copy: "Set the base URL and endpoint path supplied by the API owner. REST calls are GET only; use the documented JSON response format and records path." },
    { title: "Set access and bounds", copy: "Choose the documented authentication mode and environment credential reference if needed. Review timeout, response-size limit, record cap, and bounded pagination." },
    { title: "Save without starting ingestion", copy: "Save the source, then inspect its configuration. Saving or enabling it does not send a request or schedule polling.", href: "/data-sources/new", linkLabel: "Open REST source setup" },
  ] },
  { id: "test-connection", title: "Test a connection explicitly", steps: [
    { title: "Choose the appropriate test", copy: "Use bounded discovery on a configured source. The compatibility panel below tests only its three fixed, documented public APIs; it has no arbitrary URL entry." },
    { title: "Run one explicit check", copy: "A connection check calls bounded discovery and does not create a source or import records. An ingestion test creates an isolated test source and retains imported history.", href: "/help#api-compatibility-tests", linkLabel: "Open API compatibility tests" },
    { title: "Read the result before proceeding", copy: "Use the returned message to distinguish DNS, TLS, HTTP, parsing, and size-limit failures. Do not widen network access just to make a test pass." },
  ] },
  { id: "import-records", title: "Import records deliberately", steps: [
    { title: "Review the source and import type", copy: "Confirm the configured file path for JSON/CSV or the saved REST endpoint. Local file import supports JSON and CSV; REST sync is a bounded on-demand GET workflow.", href: "/data-sources", linkLabel: "Choose a source" },
    { title: "Inspect discovery and any mapping", copy: "Review observed fields and record paths. A draft mapping is optional and is not used until it has been validated and activated." },
    { title: "Choose Import or Sync now", copy: "Start the import/sync action yourself. Review processed, imported, skipped, and failed counts; the original raw payload remains available." },
  ] },
  { id: "field-discovery", title: "Review discovered fields", steps: [
    { title: "Open Discover data", copy: "On a JSON, CSV, or REST source, open the discovery workflow. Discovery is an explicit bounded sample, not an import or an asset-creation step.", href: "/data-sources", linkLabel: "Open source list" },
    { title: "Check paths, types, and examples", copy: "Compare suggested field meanings with actual source values. Exclude irrelevant fields and confirm which collection or records path is intended." },
    { title: "Decide whether to map", copy: "Only create a mapping when the source fields have a clear meaning. Validate and activate it deliberately; keep raw-only records when normalization is not needed." },
  ] },
  { id: "raw-json", title: "Inspect a raw JSON record", steps: [
    { title: "Select Source records", copy: "In Data Explorer, choose the original source-record view and filter to one source so source-specific field names remain clear.", href: "/data-explorer", linkLabel: "Open Data Explorer" },
    { title: "Open an actual record", copy: "Select a record and inspect its original payload. The record may be raw-only; an event mapping is not required to inspect it." },
    { title: "Compare the original value", copy: "Use raw payload view when you need exact JSON. Treat previews and recognition as context; verify any important field in the original record." },
  ] },
  { id: "nested-data", title: "Read nested objects and arrays", steps: [
    { title: "Expand the parent object", copy: "Open a JSON object in the record tree and note the exact keys at each level. For example, an inner value can have a path like machine.state." },
    { title: "Expand an array item", copy: "Arrays show indexed entries such as alarms[0]. Review the item itself and its child fields rather than assuming array contents are flat." },
    { title: "Check variation across records", copy: "Look at multiple records before using a path. A path can be absent, null, or differently shaped in other source records.", href: "/data-explorer", linkLabel: "Inspect records" },
  ] },
  { id: "search-filter", title: "Search and filter records", steps: [
    { title: "Choose the data mode", copy: "Select Source records for original payloads or Normalized events for records produced through a mapping.", href: "/data-explorer", linkLabel: "Open Data Explorer" },
    { title: "Apply a focused search", copy: "Search by a source key, record content, event type, or payload text as appropriate to the chosen view. Narrow by source to avoid confusing similar fields." },
    { title: "Refine and verify", copy: "For events, use event type and occurrence-time filters. Check page and total counts, then open a result to verify it is the intended record." },
  ] },
  { id: "fault-frequency", title: "Explore fault frequency", steps: [
    { title: "Start with raw records", copy: "Select a source and review its original records first. Identify a field whose values actually represent a fault code or category; do not assume one is present.", href: "/visualisations", linkLabel: "Open Visualisations" },
    { title: "Choose frequency and the exact field", copy: "In raw-record visualisations, select a frequency view and the observed category field. Apply a search or date range only when the source has a reliable field for it." },
    { title: "Interpret counts in context", copy: "Counts describe values in the loaded records and selected source/filter context, not a verified fault rate. Check missing values and duplicates before drawing conclusions." },
  ] },
  { id: "time-series", title: "Build a time-series view", steps: [
    { title: "Confirm a timestamp and numeric field", copy: "Inspect records and confirm the source fields and units. KuduNS does not infer time zones; an explicit source offset or documented time-zone rule is needed.", href: "/visualisations", linkLabel: "Open Visualisations" },
    { title: "Select the time-series definition", copy: "Choose a timestamp field and a numeric value field. In imported-event mode, select the source, event type, and exact numeric payload path." },
    { title: "Check ordering and gaps", copy: "Review the chosen range, UTC display, and plotted points. Missing points may reflect missing source values, filtering, or data not present in the loaded result." },
  ] },
  { id: "state-distribution", title: "Explore state distribution", steps: [
    { title: "Find an observed state field", copy: "Inspect raw records or event payloads and choose a scalar field containing the states you want to compare. Confirm the values and spelling.", href: "/visualisations", linkLabel: "Open Visualisations" },
    { title: "Choose a distribution view", copy: "Select the relevant source and category/state field. A distribution counts observed categories in the loaded records." },
    { title: "Review scope before interpreting", copy: "Check the selected source and filters, and look for null or missing values. The chart describes these records; it does not classify machine health." },
  ] },
  { id: "save-reopen", title: "Save and reopen a view", steps: [
    { title: "Name the configuration", copy: "Enter a useful view name and finish selecting its source, filters, and fields. Check that the preview shows the intended data." },
    { title: "Save the definition", copy: "Save visualisation stores the query definition in this browser profile. It does not store source credentials, raw payloads, or event results.", href: "/visualisations", linkLabel: "Open Visualisations" },
    { title: "Reopen it from the local list", copy: "Choose the saved view to reload its definition and read current data. If fields have changed, select valid paths and save an updated configuration." },
  ] },
  { id: "export-original", title: "Export original records", steps: [
    { title: "Choose Source records", copy: "Open Data Explorer and select the raw Source records mode when the original payload is what you need.", href: "/data-explorer", linkLabel: "Open Data Explorer" },
    { title: "Set the intended scope", copy: "Choose a source and search or sort as needed. Review the visible scope before exporting; selected-field preview CSV is for the current page." },
    { title: "Choose a supported export format", copy: "Use the export control for JSON, CSV, or XLSX. The source-record export is distinct from normalized event export. Handle the downloaded file according to your site policy." },
  ] },
  { id: "multiple-sources", title: "Compare multiple sources", steps: [
    { title: "Register sources separately", copy: "Give each source a distinct key and review its own access, format, and record path. Registration does not connect or ingest.", href: "/data-sources", linkLabel: "Review data sources" },
    { title: "Inspect each source on its own", copy: "Use the source scope in Data Explorer and verify field paths, units, clocks, and state values independently." },
    { title: "Compare only confirmed equivalents", copy: "Identical field names may not mean identical measurements or states. Keep source identity visible and avoid combining values until the meaning is verified.", href: "/data-explorer", linkLabel: "Open Data Explorer" },
  ] },
];

function readTutorialProgress(): TutorialProgress {
  const initial = { tutorialIndex: 0, stepIndex: 0, completed: false };
  if (typeof window === "undefined") return initial;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return initial;
    const value = parsed as Partial<TutorialProgress>;
    if (!Number.isInteger(value.tutorialIndex) || !Number.isInteger(value.stepIndex) || typeof value.completed !== "boolean") return initial;
    const tutorialIndex = Math.max(0, Math.min(tutorials.length - 1, value.tutorialIndex as number));
    const stepIndex = Math.max(0, Math.min(tutorials[tutorialIndex].steps.length - 1, value.stepIndex as number));
    return { tutorialIndex, stepIndex, completed: value.completed };
  } catch {
    return initial;
  }
}

export default function HelpPage({ children }: { children?: ReactNode }) {
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState<TutorialProgress>(readTutorialProgress);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredSections = useMemo(() => sections.map((section) => ({
    ...section,
    articles: section.articles.filter((article) => !normalizedSearch ||
      `${article.title} ${article.searchText} ${section.title} ${section.label}`.toLocaleLowerCase().includes(normalizedSearch)),
  })).filter((section) => section.articles.length > 0), [normalizedSearch]);

  const totalSteps = tutorials.reduce((sum, tutorial) => sum + tutorial.steps.length, 0);
  const stepOffset = tutorials.slice(0, progress.tutorialIndex).reduce((sum, tutorial) => sum + tutorial.steps.length, 0);
  const progressCount = progress.completed ? totalSteps : stepOffset + progress.stepIndex;
  const currentTutorial = tutorials[progress.tutorialIndex];
  const currentStep = currentTutorial.steps[progress.stepIndex];
  const stepNumber = stepOffset + progress.stepIndex + 1;
  const progressPercent = progress.completed ? 100 : Math.round((progressCount / totalSteps) * 100);

  useEffect(() => {
    try {
      window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      // Tutorial progress remains usable for this session if browser storage is unavailable.
    }
  }, [progress]);

  const moveTutorial = (direction: -1 | 1) => {
    setProgress((current) => {
      if (direction === 1 && current.tutorialIndex === tutorials.length - 1 && current.stepIndex === tutorials[current.tutorialIndex].steps.length - 1) {
        return { ...current, completed: true };
      }
      if (direction === 1) {
        const stepsInTutorial = tutorials[current.tutorialIndex].steps.length;
        if (current.stepIndex < stepsInTutorial - 1) return { ...current, stepIndex: current.stepIndex + 1, completed: false };
        return { tutorialIndex: current.tutorialIndex + 1, stepIndex: 0, completed: false };
      }
      if (current.stepIndex > 0) return { ...current, stepIndex: current.stepIndex - 1, completed: false };
      if (current.tutorialIndex > 0) {
        const previousIndex = current.tutorialIndex - 1;
        return { tutorialIndex: previousIndex, stepIndex: tutorials[previousIndex].steps.length - 1, completed: false };
      }
      return current;
    });
  };

  const chooseTutorial = (tutorialIndex: number) => {
    setProgress({ tutorialIndex, stepIndex: 0, completed: false });
  };

  return <main className="page-main help-page" data-testid="page-help">
    <header className="help-hero">
      <div className="help-hero-grid">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />OPERATIONS GUIDE · ON-PREMISES DATA</div>
          <h1>Understand the data.<br />Choose what happens next.</h1>
          <p className="help-hero-intro">Practical guidance for connecting REST, JSON, and CSV sources, inspecting the original records, and choosing when optional normalization is useful.</p>
        </div>
        <aside className="help-hero-aside" aria-label="KuduNS source safety">
          <strong>OPERATOR-CONTROLLED</strong>
          <p>Registration is not ingestion. REST access is an explicit bounded GET. Original payloads remain inspectable.</p>
        </aside>
      </div>
    </header>

    <div className="help-top-tools">
      <div className="help-search">
        <label htmlFor="help-search-input">Search help topics</label>
        <input id="help-search-input" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Try “timezone”, “nested JSON”, or “export”" data-testid="input-help-search" />
        <span className="help-search-mark" aria-hidden="true">⌕</span>
      </div>
      <nav className="help-quick-links" aria-label="Help shortcuts">
        <Link href="/data-sources" data-testid="link-help-shortcut-sources">Data sources</Link>
        <Link href="/data-explorer" data-testid="link-help-shortcut-explorer">Data Explorer</Link>
        <Link href="/visualisations" data-testid="link-help-shortcut-visualisations">Visualisations</Link>
      </nav>
    </div>

    <div className="help-layout">
      <nav className="help-index" aria-label="Help sections" data-testid="nav-help-sections">
        <p className="help-index-title">IN THIS GUIDE</p>
        {sections.map((section) => <a key={section.id} href={`#${section.id}`} data-testid={`link-help-section-${section.id}`}>{section.label}</a>)}
        <a className="help-index-secondary" href="#guided-tutorials" data-testid="link-help-section-tutorials">Guided tutorials</a>
        <a href="#api-compatibility-tests" data-testid="link-help-section-compatibility">API compatibility tests</a>
      </nav>

      <div className="help-content">
        {filteredSections.length > 0 ? filteredSections.map((section) => <section className="help-section" id={section.id} key={section.id} aria-labelledby={`help-heading-${section.id}`} data-testid={`section-help-${section.id}`}>
          <header className="help-section-heading">
            <div><span className="section-label">{section.label.toUpperCase()}</span><h2 id={`help-heading-${section.id}`}>{section.title}</h2><p>{section.description}</p></div>
            <span className="help-section-count">{section.articles.length.toString().padStart(2, "0")} TOPICS</span>
          </header>
          <div className="help-article-list">
            {section.articles.map((article, index) => <details className="help-article" key={article.id} data-testid={`article-help-${article.id}`}>
              <summary><span className="help-article-number">{String(index + 1).padStart(2, "0")}</span><span>{article.title}</span></summary>
              <div className="help-article-body" data-testid={`content-help-${article.id}`}>{article.content}</div>
            </details>)}
          </div>
        </section>) : <div className="help-empty-search" role="status" data-testid="status-help-no-results">No help topics match “{search}”. Try a broader term such as REST, records, or time.</div>}

        <section className="help-section" id="guided-tutorials" aria-labelledby="help-tutorials-heading" data-testid="section-help-tutorials">
          <header className="help-section-heading">
            <div><span className="section-label">GUIDED WORKFLOWS</span><h2 id="help-tutorials-heading">Learn by doing</h2><p>Fourteen short operator-led walkthroughs. Your place in the guide is saved in this browser; no source data or credentials are stored here.</p></div>
            <span className="help-section-count">14 TUTORIALS</span>
          </header>
          <div className="help-tutorial-panel" data-testid="panel-help-tutorial">
            <div className="help-tutorial-top">
              <div className="help-tutorial-topline"><span className="section-label">TUTORIAL {String(progress.tutorialIndex + 1).padStart(2, "0")} / {String(tutorials.length).padStart(2, "0")}</span><span className="help-resume-tag" data-testid="status-help-resume">{progress.completed ? "COMPLETE" : progressCount > 0 ? "RESUMED" : "READY WHEN YOU ARE"}</span></div>
              <h2 data-testid="text-help-tutorial-title">{currentTutorial.title}</h2>
              <p>Step {progress.stepIndex + 1} of {currentTutorial.steps.length} · Overall guide progress {progressCount} of {totalSteps} steps</p>
            </div>
            <div className="help-tutorial-body">
              <div className="help-tutorial-meta"><span data-testid="text-help-progress-count">{progress.completed ? "ALL STEPS COMPLETE" : `STEP ${String(stepNumber).padStart(2, "0")} OF ${String(totalSteps).padStart(2, "0")}`}</span><span>{progressPercent}%</span></div>
              <div className="help-progress-track" role="progressbar" aria-label="Tutorial progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} data-testid="progress-help-tutorial"><div className="help-progress-fill" style={{ width: `${progressPercent}%` }} /></div>
              {progress.completed ? <div className="help-complete" role="status" data-testid="status-help-complete">Tutorial guide complete. You can revisit any walkthrough from the list below; your browser keeps your current position only.</div> : <>
                <h3 className="help-step-title" data-testid="text-help-step-title">{currentStep.title}</h3>
                <p className="help-step-copy" data-testid="text-help-step-copy">{currentStep.copy}</p>
                {currentStep.href && <div className="help-tutorial-links"><Link href={currentStep.href} data-testid={`link-help-tutorial-${currentTutorial.id}`}>{currentStep.linkLabel ?? "Open relevant page"}</Link></div>}
              </>}
              <div className="help-tutorial-controls">
                <button className="button" type="button" onClick={() => moveTutorial(-1)} disabled={progress.tutorialIndex === 0 && progress.stepIndex === 0} data-testid="button-help-previous">Previous</button>
                <div>
                  {progress.completed && <button className="button" type="button" onClick={() => chooseTutorial(0)} data-testid="button-help-restart">Start again</button>}
                  <button className="button button-primary" type="button" onClick={() => moveTutorial(1)} disabled={progress.completed} data-testid="button-help-next">{progress.tutorialIndex === tutorials.length - 1 && progress.stepIndex === currentTutorial.steps.length - 1 ? "Complete guide" : "Next"}</button>
                </div>
              </div>
            </div>
            <div className="help-tutorial-list" aria-label="Choose a tutorial">
              {tutorials.map((tutorial, index) => <button className="help-tutorial-choice" type="button" key={tutorial.id} onClick={() => chooseTutorial(index)} aria-current={progress.tutorialIndex === index ? "step" : undefined} data-testid={`button-help-select-tutorial-${tutorial.id}`}>
                <span>{String(index + 1).padStart(2, "0")}</span><span><strong>{tutorial.title}</strong><small>{tutorial.steps.length} GUIDED STEPS</small></span>
              </button>)}
            </div>
          </div>
        </section>

        <section className="help-compat-section" id="api-compatibility-tests" aria-labelledby="help-compat-title" data-testid="section-api-compatibility-tests">
          <span className="section-label">REFERENCE TOOL</span>
          <h2 id="help-compat-title">API compatibility tests</h2>
          <p>Use this operator-triggered runner for JSONPlaceholder, Open-Meteo, and USGS GeoJSON. It has no editable URL field; all three APIs are requested through the same KuduNS discovery and raw-record ingestion paths.</p>
          {children}
        </section>
      </div>
    </div>
  </main>;
}
