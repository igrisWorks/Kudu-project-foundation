import assert from "node:assert/strict";
import test from "node:test";
import { validateCaBundle } from "./validate-docker-ca.mjs";

test("Docker CA validation rejects empty, malformed, and non-PEM values", () => {
  assert.throws(() => validateCaBundle(""), /is empty/);
  assert.throws(() => validateCaBundle("not a certificate"), /PEM-encoded/);
  assert.throws(
    () => validateCaBundle("-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"),
    /invalid PEM certificate/,
  );
});
