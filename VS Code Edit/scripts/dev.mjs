import { spawn, spawnSync } from "node:child_process";
import { open, readFile, unlink } from "node:fs/promises";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(projectRoot, ".kudu-dev.lock");
const noBrowser = process.argv.includes("--no-browser") || process.env.KUDU_OPEN_BROWSER === "0";
const url = "http://127.0.0.1:5173";
let lockHandle;
let serverProcess;
let stopping = false;

function fail(message) {
  console.error(`Kudu local startup: ${message}`);
  process.exitCode = 1;
  throw new Error("LOCAL_STARTUP_FAILED");
}

function executable(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
  return result;
}

function pnpmInvocation(args) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli) return { command: process.execPath, args: [pnpmCli, ...args] };
  if (process.platform === "win32") return { command: "pnpm.cmd", args };
  return { command: "pnpm", args };
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      const current = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      if (isPidRunning(current)) fail(`another local startup is already running (PID ${current}). Stop it before starting another.`);
      await unlink(lockPath).catch(() => undefined);
    }
  }
  fail("could not acquire the local startup lock.");
}

async function releaseLock() {
  const ownedLock = Boolean(lockHandle);
  await lockHandle?.close().catch(() => undefined);
  lockHandle = undefined;
  if (ownedLock) await unlink(lockPath).catch(() => undefined);
}

async function checkPort(port) {
  return await new Promise(resolvePromise => {
    const server = net.createServer();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function configuredDatabaseTarget() {
  try {
    const stored = JSON.parse(await readFile(resolve(projectRoot, ".kudu-local-database.json"), "utf8"));
    const source = stored.encoding === "dpapi-current-user" ? stored : stored.settings;
    return { host: source?.host, port: Number(source?.port) };
  } catch {
    // A missing local settings file is normal on first startup.
  }
  try {
    const envText = await readFile(resolve(projectRoot, ".env"), "utf8");
    const line = envText.split(/\r?\n/).find(value => /^\s*DATABASE_URL\s*=/.test(value));
    if (!line) return { host: "127.0.0.1", port: 5432 };
    const rawValue = line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    const parsed = new URL(rawValue);
    return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 5432 };
  } catch {
    return { host: "127.0.0.1", port: 5432 };
  }
}

async function tcpReachable(host, port, timeoutMs = 900) {
  return await new Promise(resolvePromise => {
    const socket = net.createConnection({ host, port });
    const done = value => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function startWindowsPostgresService() {
  const powershell = executable("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference='SilentlyContinue'; Get-Service -Name 'postgresql*' | Where-Object { $_.Name -match '^postgresql-x64-\\d+$' } | ForEach-Object { \"$($_.Name)|$($_.Status)\" }",
  ]);
  if (powershell.error || powershell.status !== 0) {
    return { started: false, reason: "Could not inspect Windows PostgreSQL services." };
  }
  const services = (powershell.stdout ?? "").split(/\r?\n/).map(line => {
    const [name, status] = line.trim().split("|");
    return { name, status };
  }).filter(service => service.name && /^postgresql-x64-\d+$/.test(service.name));
  if (services.length !== 1) {
    return {
      started: false,
      reason: services.length > 1
        ? "Multiple PostgreSQL services were found; no service was started automatically."
        : "No matching PostgreSQL Windows service was found.",
    };
  }
  const service = services[0];
  if (!service) return { started: false, reason: "No matching PostgreSQL Windows service was found." };
  if (service.status !== "Stopped") {
    return { started: false, reason: "The PostgreSQL Windows service is already running but its port is unreachable." };
  }
  const start = executable("sc.exe", ["start", service.name]);
  if (start.error || start.status !== 0) {
    return {
      started: false,
      reason: `Could not start ${service.name}; run PowerShell as an administrator or start the service in Windows Services.`,
    };
  }
  return { started: true, reason: `${service.name} start was requested.` };
}

async function checkPostgres() {
  const target = await configuredDatabaseTarget();
  if (typeof target.host !== "string" || !["127.0.0.1", "::1", "localhost"].includes(target.host.replace(/^\[|\]$/g, "").toLowerCase())) {
    console.error("Kudu local startup: local database host must be loopback; use Settings → Database to configure it.");
    return;
  }
  if (await tcpReachable(target.host, target.port)) {
    console.log(`PostgreSQL is reachable on the configured local port ${target.port}.`);
    return;
  }

  let startResult = { started: false, reason: "Automatic PostgreSQL service startup is only attempted for a single stopped Windows service." };
  if (process.platform === "win32") startResult = await startWindowsPostgresService();
  console.log(`PostgreSQL did not respond on ${target.host}:${target.port}. ${startResult.reason}`);
  if (startResult.started) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
      if (await tcpReachable(target.host, target.port)) {
        console.log("PostgreSQL is now reachable.");
        return;
      }
    }
  }
  console.error("The web edition will start in disconnected mode. Start PostgreSQL and enter its local connection in Settings → Database.");
}

async function runPnpm(args, env = process.env) {
  const invocation = pnpmInvocation(args);
  const result = executable(invocation.command, invocation.args, { env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`command exited with code ${result.status ?? 1}.`);
}

function startDevelopmentServers(env) {
  const invocation = pnpmInvocation([
    "--filter", "@kudu/backend",
    "--filter", "@kudu/frontend",
    "--parallel", "--stream", "dev",
  ]);
  serverProcess = spawn(invocation.command, invocation.args, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32" && invocation.command.endsWith(".cmd"),
    detached: process.platform !== "win32",
  });
  serverProcess.once("error", error => {
    console.error(`Kudu local startup: could not start the development servers: ${error.message}`);
    process.exitCode = 1;
  });
  serverProcess.once("exit", code => {
    if (!stopping) process.exitCode = code ?? 1;
    void releaseLock();
  });
}

async function waitForApplication(timeoutMs = 45_000) {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt && serverProcess && serverProcess.exitCode === null) {
    try {
      const [frontend, backend] = await Promise.all([
        fetch(url, { signal: AbortSignal.timeout(1000) }),
        fetch("http://127.0.0.1:3000/healthz", { signal: AbortSignal.timeout(1000) }),
      ]);
      if (frontend.ok && backend.ok) return true;
    } catch {
      // Wait for Vite to start.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  return false;
}

function openBrowser() {
  const command = process.platform === "win32"
    ? "cmd.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
}

async function stopDevelopmentServers(signal = "SIGINT") {
  if (stopping) return;
  stopping = true;
  if (!serverProcess || serverProcess.exitCode !== null) {
    await releaseLock();
    return;
  }
  if (process.platform === "win32") {
    executable("taskkill.exe", ["/PID", String(serverProcess.pid), "/T", "/F"]);
  } else {
    try {
      process.kill(-serverProcess.pid, signal);
    } catch {
      serverProcess.kill(signal);
    }
  }
  setTimeout(() => {
    void releaseLock();
  }, 2500).unref();
}

process.once("SIGINT", () => void stopDevelopmentServers("SIGINT"));
process.once("SIGTERM", () => void stopDevelopmentServers("SIGTERM"));

try {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24 || nodeMajor >= 25) fail(`Node.js ${process.versions.node} is installed; package.json requires Node.js 24.`);
  const version = executable(pnpmInvocation(["--version"]).command, pnpmInvocation(["--version"]).args);
  const requiredPnpm = String(packageJson.packageManager).replace(/^pnpm@/, "");
  if (version.status !== 0 || version.stdout.trim() !== requiredPnpm) {
    fail(`pnpm ${version.stdout?.trim() || "was not found"} is installed; package.json requires pnpm ${requiredPnpm}.`);
  }
  await acquireLock();
  for (const port of [3000, 5173]) {
    if (!(await checkPort(port))) fail(`port ${port} is already in use. Stop the owning process and retry.`);
  }
  await checkPostgres();
  const env = { ...process.env, KUDU_LOCAL_MODE: "true", HOST: "127.0.0.1", PORT: "3000" };
  // The Replit/workspace environment may inject a managed database URL. The local
  // edition must use only its own ignored settings file or this project's .env.
  delete env.DATABASE_URL;
  if (env.NODE_ENV?.toLowerCase() === "production") fail("KUDU_LOCAL_MODE cannot run with NODE_ENV=production.");
  console.log("Building shared contracts...");
  await runPnpm(["--filter", "@kudu/shared", "build"], env);
  console.log(`Starting Kudu Local Web Edition at ${url}. Press Ctrl+C to stop.`);
  startDevelopmentServers(env);
  if (!(await waitForApplication())) {
    if (serverProcess?.exitCode === null) {
      console.error("Kudu local startup: the frontend and API did not both become ready within 45 seconds; inspect the server output above.");
      process.exitCode = 1;
      await stopDevelopmentServers("SIGTERM");
    }
  } else {
    if (!noBrowser) openBrowser();
  }
} catch (error) {
  if (!(error instanceof Error && error.message === "LOCAL_STARTUP_FAILED")) {
    console.error(`Kudu local startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
  await stopDevelopmentServers("SIGTERM");
  await releaseLock();
}
