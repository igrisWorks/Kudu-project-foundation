import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parsePort(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error("KUDU_LOCAL_WEB_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("KUDU_LOCAL_WEB_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

async function readPortFromEnvFile(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const line = contents.split(/\r?\n/).find(entry => /^\s*KUDU_LOCAL_WEB_PORT\s*=/.test(entry));
  if (!line) return undefined;
  const raw = line.slice(line.indexOf("=") + 1).trim();
  return raw.replace(/^(["'])(.*)\1$/, "$2");
}

export async function configuredPort(environment = process.env, envFile = join(projectRoot, ".env")) {
  const shellValue = environment.KUDU_LOCAL_WEB_PORT;
  const fileValue = shellValue === undefined || shellValue === ""
    ? await readPortFromEnvFile(envFile)
    : undefined;
  return parsePort(shellValue || fileValue || "3000");
}

export function isPortAvailable(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", error => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolvePromise(false);
      } else {
        reject(error);
      }
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolvePromise(true));
    });
  });
}

function requestedProfiles(args) {
  if (args.length === 0) return [];
  throw new Error("Usage: pnpm docker:local. Local now uses embedded SQLite; no PostgreSQL profile is required. Existing PostgreSQL volumes are not removed.");
}

async function startLocalDocker() {
  const profiles = requestedProfiles(process.argv.slice(2));
  const port = await configuredPort();
  if (!await isPortAvailable(port)) {
    console.error(`Kudu cannot start: 127.0.0.1:${port} is already in use or unavailable.`);
    console.error("Kudu did not stop or modify the service using that port.");
    console.error(`Choose another host port, for example KUDU_LOCAL_WEB_PORT=${port === 3000 ? 3002 : 3000}.`);
    console.error("To identify the listener on Windows, run: Get-NetTCPConnection -LocalPort " + port + " -State Listen");
    console.error("On macOS/Linux, run: lsof -nP -iTCP:" + port + " -sTCP:LISTEN");
    process.exitCode = 1;
    return;
  }

  const child = spawn("docker", [
    "compose",
    "-p", "kuduns-local",
    "-f", "docker-compose.local.yml",
    ...profiles,
    "up", "--build", "-d",
  ], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  child.once("error", error => {
    console.error(`Could not start Docker Compose: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("close", code => {
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLocalDocker().catch(error => {
    console.error(error instanceof Error ? error.message : "Kudu Docker startup failed.");
    process.exitCode = 1;
  });
}
