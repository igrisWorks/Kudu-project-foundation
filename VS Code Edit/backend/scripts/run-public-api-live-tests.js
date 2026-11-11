import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "src/public-api-live.integration.test.ts"],
  {
    cwd: process.cwd(),
    env: { ...process.env, KUDU_LIVE_PUBLIC_API_TESTS: "1" },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error("Could not start the opt-in public API tests.", result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
