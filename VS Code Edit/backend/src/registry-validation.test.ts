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
