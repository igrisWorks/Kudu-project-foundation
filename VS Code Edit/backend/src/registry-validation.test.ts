import assert from "node:assert/strict";
import test from "node:test";
import { ApiFailure } from "./errors.js";
import {
  validateAssetCreate,
  validateAssetUpdate,
  validateDataSourceCreate,
} from "./registry-validation.js";

function expectValidationFailure(operation: () => unknown): ApiFailure {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof ApiFailure);
    assert.equal(error.statusCode, 400);
    return error;
  }
  assert.fail("Expected request validation to fail.");
}

test("asset validation requires supported fields and rejects duplicate external identifiers", () => {
  const invalid = expectValidationFailure(() =>
    validateAssetCreate({
      assetKey: "line-1",
      name: "Line 1",
      assetType: "production_line",
      status: "active",
      externalIdentifiers: [
        { sourceKey: "erp", externalId: "1" },
        { sourceKey: "ERP", externalId: "1" },
      ],
    }),
  );
  assert.ok(invalid.fields?.status);
  assert.ok(invalid.fields?.["externalIdentifiers.1"]);
  const invalidIdentifier = expectValidationFailure(() =>
    validateAssetCreate({
      assetKey: "line-2",
      name: "Line 2",
      assetType: "production_line",
      externalIdentifiers: [{ sourceKey: "invalid key", externalId: "2" }],
    }),
  );
  assert.ok(invalidIdentifier.fields?.["externalIdentifiers.0.sourceKey"]);

  assert.deepEqual(
    validateAssetUpdate({ description: null, parentAssetId: null }),
    { description: null, parentAssetId: null },
  );
  expectValidationFailure(() => validateAssetUpdate({}));
});

test("REST configuration permits only safe HTTP metadata and environment references", () => {
  const input = {
    sourceKey: "erp",
    displayName: "ERP",
    sourceType: "rest_api",
    configuration: {
      kind: "rest_api",
      baseUrl: "https://erp.example.test/api",
      credentialRef: "env:KUDU_SOURCE_ERP_TOKEN",
    },
  };
  assert.deepEqual(validateDataSourceCreate(input).configuration, input.configuration);

  expectValidationFailure(() =>
    validateDataSourceCreate({
      ...input,
      configuration: { kind: "rest_api", baseUrl: "file:///etc/passwd" },
    }),
  );
  expectValidationFailure(() =>
    validateDataSourceCreate({
      ...input,
      configuration: { kind: "rest_api", baseUrl: "https://user:pass@erp.example.test/api" },
    }),
  );
  expectValidationFailure(() =>
    validateDataSourceCreate({
      ...input,
      configuration: { kind: "rest_api", baseUrl: "https://erp.example.test/api?token=secret" },
    }),
  );
  expectValidationFailure(() =>
    validateDataSourceCreate({
      ...input,
      configuration: {
        kind: "rest_api",
        baseUrl: "https://erp.example.test/api",
        credentialRef: "plaintext-secret-value",
      },
    }),
  );
});

test("REST private-host trust is explicit and bound to the configured base URL host", () => {
  const base = {
    sourceKey: "factory-api",
    displayName: "Factory API",
    sourceType: "rest_api",
    configuration: {
      kind: "rest_api",
      baseUrl: "http://10.11.36.65/api",
      trustedPrivateHost: "10.11.36.65",
    },
  };
  assert.equal(validateDataSourceCreate(base).configuration.kind, "rest_api");
  expectValidationFailure(() => validateDataSourceCreate({
    ...base,
    configuration: { ...base.configuration, trustedPrivateHost: "10.11.36.66" },
  }));
  expectValidationFailure(() => validateDataSourceCreate({
    ...base,
    configuration: { ...base.configuration, trustedPrivateHost: "*" },
  }));
});

test("REST pagination is opt-in and validates bounded strategies and parameters", () => {
  const base = {
    sourceKey: "history",
    displayName: "Historical API",
    sourceType: "rest_api",
    configuration: {
      kind: "rest_api",
      baseUrl: "https://erp.example.test/api",
      endpointPath: "events",
      maxRecords: 100_000,
      pagination: {
        strategy: "cursor",
        pageSize: 250,
        limitParameter: "limit",
        cursorParameter: "cursor",
        nextCursorPath: "page.next",
        requestIntervalMs: 300,
        dateFromParameter: "from",
        dateFrom: "2026-01-01",
      },
    },
  };
  const validated = validateDataSourceCreate(base);
  assert.equal(validated.configuration.kind, "rest_api");
  if (validated.configuration.kind === "rest_api") {
    assert.deepEqual(validated.configuration.pagination, base.configuration.pagination);
  }
  expectValidationFailure(() => validateDataSourceCreate({
    ...base,
    configuration: {
      ...base.configuration,
      maxRecords: 100_001,
    },
  }));
  expectValidationFailure(() => validateDataSourceCreate({
    ...base,
    configuration: {
      ...base.configuration,
      pagination: { ...base.configuration.pagination, cursorParameter: "bad&cursor" },
    },
  }));
  expectValidationFailure(() => validateDataSourceCreate({
    ...base,
    configuration: {
      ...base.configuration,
      pagination: { ...base.configuration.pagination, nextCursorPath: "__proto__.next" },
    },
  }));
});

test("file source paths must stay relative to their configured data root", () => {
  const base = {
    sourceKey: "archive",
    displayName: "Archive",
    sourceType: "csv_file",
  };
  assert.equal(
    validateDataSourceCreate({
      ...base,
      configuration: { kind: "csv_file", relativePath: "plant/archive/records.csv" },
    }).configuration.kind,
    "csv_file",
  );
  expectValidationFailure(() =>
    validateDataSourceCreate({
      ...base,
      configuration: { kind: "csv_file", relativePath: "../../etc/passwd" },
    }),
  );
  expectValidationFailure(() =>
    validateDataSourceCreate({
      ...base,
      configuration: { kind: "csv_file", relativePath: "/etc/passwd" },
    }),
  );
});
