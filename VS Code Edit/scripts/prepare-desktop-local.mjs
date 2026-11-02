import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "desktop/local-backend");
// This is generated packaging output only, never the user application-data directory.
await rm(destination, { recursive: true, force: true });
const cli = process.env.npm_execpath;
const result = spawnSync(cli ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [...(cli ? [cli] : []), "--filter", "@kudu/backend", "deploy", "--legacy", "--prod", destination],
  { cwd: root, stdio: "inherit", shell: !cli && process.platform === "win32" });
if (result.status !== 0) throw new Error("Unable to prepare the standalone Local backend.");
await mkdir(join(destination, "frontend"), { recursive: true });
await cp(join(root, "frontend/dist"), join(destination, "frontend"), { recursive: true });
await cp(join(root, "database/sqlite-migrations"), join(destination, "sqlite-migrations"), { recursive: true });
await rm(join(destination, "dist/test-support"), { recursive: true, force: true });
for (const name of await readdir(join(destination, "dist"))) {
  if (/\.test\.(js|d\.ts)$/.test(name)) await rm(join(destination, "dist", name));
}
console.log(`Prepared Local runtime for ${process.platform}/${process.arch}. Package on the target OS; do not cross-package native SQLite binaries.`);
