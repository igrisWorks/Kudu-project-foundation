"use strict";

function parseServerUrl(value, allowInsecureHttp = false) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2048) {
    throw new Error("Enter a valid KuduNS server address.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete server address beginning with https:// or http://.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTPS and HTTP server addresses are supported.");
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error("The server address must not contain credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter the server base address only, without a path, query, or fragment.");
  }
  if (url.protocol === "http:" && allowInsecureHttp !== true) {
    throw new Error("HTTP is unencrypted. Acknowledge that this is a trusted local or isolated LAN connection.");
  }

  return url;
}

function isSameOrigin(value, origin) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
  } catch {
    return false;
  }
}

function validatedExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isSandboxDisabledByArgs(args) {
  return Array.isArray(args) && args.includes("--no-sandbox");
}

module.exports = {
  isSameOrigin,
  isSandboxDisabledByArgs,
  parseServerUrl,
  validatedExternalUrl,
};
