import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../backend/dist/sqlite-database.js";
const directory = await mkdtemp(join(tmpdir(), "kuduns-check-"));
try {
  const database = await createSqliteDatabase(directory);
  console.log("SQLite native module, migrations and integrity checks passed in a temporary database.");
  await database.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}
