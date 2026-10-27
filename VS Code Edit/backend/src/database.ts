import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

export interface Database {
  [tableName: string]: Record<string, unknown>;
}

export function createDatabase(connectionString: string): {
  db: Kysely<Database>;
  close: () => Promise<void>;
} {
  const pool = new Pool({
    connectionString,
    max: 10,
    application_name: "kudu-api",
  });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
  return {
    db,
    close: async () => {
      await db.destroy();
    },
  };
}

export async function checkDatabase(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
