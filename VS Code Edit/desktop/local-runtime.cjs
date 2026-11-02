"use strict";
const path = require("node:path");
const fs = require("node:fs");

function runtimePaths(app) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "local-backend")
    : path.resolve(__dirname, "../backend");
  return {
    entry: path.join(base, "dist/index.js"),
    frontend: app.isPackaged ? path.join(base, "frontend") : path.resolve(__dirname, "../frontend/dist"),
    migrations: app.isPackaged ? path.join(base, "sqlite-migrations") : path.resolve(__dirname, "../database/sqlite-migrations"),
  };
}

function runtimeEnvironment(dataDirectory, paths, inherited = process.env) {
  const env = { ...inherited };
  for (const key of ["DATABASE_URL", "KUDU_AUTH_PASSWORD_HASH", "SESSION_SECRET", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  return {
    ...env, NODE_ENV: "production", KUDU_LOCAL_MODE: "true", KUDU_LOCAL_DESKTOP: "true",
    KUDU_LOCAL_DOCKER: "false", HOST: "127.0.0.1", PORT: "0",
    KUDU_DATA_DIR: dataDirectory, KUDU_FRONTEND_DIST_DIR: paths.frontend,
    KUDU_SQLITE_MIGRATIONS_DIR: paths.migrations,
  };
}

async function startLocalRuntime(app, utilityProcess, onSpawn = () => {}) {
  const paths = runtimePaths(app);
  if (!fs.existsSync(paths.entry) || !fs.existsSync(path.join(paths.frontend, "index.html"))) {
    throw new Error("The packaged Local backend or frontend is missing. Rebuild the complete desktop package.");
  }
  const dataDirectory = app.getPath("userData");
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(dataDirectory, "local-runtime.log");
  const log = fs.createWriteStream(logPath, { fd: fs.openSync(logPath, "a", 0o600) });
  log.on("error", () => {});
  const child = utilityProcess.fork(paths.entry, [], {
    env: runtimeEnvironment(dataDirectory, paths), stdio: "pipe", serviceName: "KuduNS Local backend",
  });
  onSpawn(child);
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("exit", () => log.end());
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Local database initialization timed out. Inspect local-runtime.log in the application data folder.")), 30000);
      child.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`Local backend stopped (${code}). Inspect local-runtime.log; do not delete the database.`));
      });
      child.on("message", message => {
        if (message?.type !== "ready" || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${message.port}`);
      });
    });
    const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok || (await response.json()).database !== "connected") throw new Error("The local SQLite backend did not pass its readiness check.");
    return { child, origin, dataDirectory };
  } catch (error) {
    child.kill();
    throw error;
  }
}

module.exports = { runtimePaths, runtimeEnvironment, startLocalRuntime };
