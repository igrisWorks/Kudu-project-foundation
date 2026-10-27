import type { AuthConfiguration } from "./auth.js";

export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: string;
  auth: AuthConfiguration;
}

const allowedLogLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Copy .env.example to .env and configure it.");
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres: or postgresql: protocol.");
  }
  if (!parsedDatabaseUrl.hostname || parsedDatabaseUrl.pathname.length < 2) {
    throw new Error("DATABASE_URL must include a database host and database name.");
  }

  const rawPort = environment.PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const logLevel = environment.LOG_LEVEL?.trim() || "info";
  if (!allowedLogLevels.has(logLevel)) {
    throw new Error("LOG_LEVEL must be fatal, error, warn, info, debug, trace, or silent.");
  }
  const rawCookieSecure = environment.KUDU_COOKIE_SECURE?.trim().toLowerCase();
  if (rawCookieSecure && rawCookieSecure !== "true" && rawCookieSecure !== "false") {
    throw new Error("KUDU_COOKIE_SECURE must be true or false.");
  }

  return {
    databaseUrl,
    host: environment.HOST?.trim() || "127.0.0.1",
    port,
    logLevel,
    auth: {
      passwordHash: environment.KUDU_AUTH_PASSWORD_HASH?.trim() || undefined,
      sessionSecret: environment.SESSION_SECRET?.trim() || undefined,
      cookieSecure: rawCookieSecure !== "false",
    },
  };
}
