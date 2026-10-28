"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isSameOrigin, parseServerUrl, validatedExternalUrl } = require("./connection-policy.cjs");

test("normalizes a secure KuduNS base URL", () => {
  assert.equal(parseServerUrl("  https://kudu.example.local/  ").origin, "https://kudu.example.local");
});

test("requires an explicit acknowledgement for HTTP", () => {
  assert.throws(() => parseServerUrl("http://127.0.0.1:3000"), /HTTP is unencrypted/);
  assert.equal(parseServerUrl("http://127.0.0.1:3000", true).origin, "http://127.0.0.1:3000");
});

test("rejects unsupported schemes, credentials, and non-base URLs", () => {
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@kudu.example.local",
    "https://kudu.example.local/tenant",
    "https://kudu.example.local?next=/",
    "https://kudu.example.local/#section",
  ]) {
    assert.throws(() => parseServerUrl(value, true), undefined, value);
  }
});

test("navigation remains on the selected origin", () => {
  assert.equal(isSameOrigin("https://kudu.example.local/assets", "https://kudu.example.local"), true);
  assert.equal(isSameOrigin("https://other.example.local/", "https://kudu.example.local"), false);
  assert.equal(isSameOrigin("file:///etc/passwd", "https://kudu.example.local"), false);
});

test("external links are limited to credential-free HTTPS destinations", () => {
  assert.equal(validatedExternalUrl("https://docs.example.com/guide"), "https://docs.example.com/guide");
  assert.equal(validatedExternalUrl("http://docs.example.com/guide"), null);
  assert.equal(validatedExternalUrl("javascript:alert(1)"), null);
  assert.equal(validatedExternalUrl("https://user:pass@docs.example.com"), null);
});
