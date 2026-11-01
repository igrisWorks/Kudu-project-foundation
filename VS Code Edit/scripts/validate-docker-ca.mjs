import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export function validateCaBundle(pem) {
  if (typeof pem !== "string" || !pem.trim()) {
    throw new Error("KUDU_DOCKER_CA_CERT is empty.");
  }

  const certificates = pem.match(certificatePattern) ?? [];
  const remainder = pem.replace(certificatePattern, "").trim();
  if (!certificates.length || remainder) {
    throw new Error("KUDU_DOCKER_CA_CERT must contain only PEM-encoded X.509 CA certificates.");
  }

  for (const certificatePem of certificates) {
    let certificate;
    try {
      certificate = new X509Certificate(certificatePem);
    } catch {
      throw new Error("KUDU_DOCKER_CA_CERT contains an invalid PEM certificate.");
    }
    if (!certificate.ca) {
      throw new Error("KUDU_DOCKER_CA_CERT contains a certificate that is not a certificate authority.");
    }
  }

  return certificates.length;
}

async function main() {
  const secretPath = process.argv[2] ?? "/run/secrets/corporate-ca";
  try {
    const pem = await readFile(secretPath, "utf8");
    validateCaBundle(pem);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("KUDU_DOCKER_CA_CERT")
      ? error.message
      : "KUDU_DOCKER_CA_CERT could not be read as a PEM certificate bundle.";
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
