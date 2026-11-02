import { AuthManager, type AuthConfiguration } from "./auth.js";

export interface AppConfig {
  databaseUrl?: string;
  host: string;
  port: number;
  logLevel: string;
  auth: AuthConfiguration;
  localMode: boolean;
  localDesktop: boolean;
  localDocker: boolean;
  localDockerPort: number;
}

const allowedLogLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const rawLocalMode = environment.KUDU_LOCAL_MODE?.trim().toLowerCase();
  if (rawLocalMode && rawLocalMode !== "true" && rawLocalMode !== "false") {
    throw new Error("KUDU_LOCAL_MODE must be true or false.");
  }
  const localMode = rawLocalMode === "true";
  const rawLocalDesktop = environment.KUDU_LOCAL_DESKTOP?.trim().toLowerCase();
  if (rawLocalDesktop && rawLocalDesktop !== "true" && rawLocalDesktop !== "false") {
    throw new Error("KUDU_LOCAL_DESKTOP must be true or false.");
  }
  const localDesktop = rawLocalDesktop === "true";
  if (localDesktop && !localMode) {
    throw new Error("KUDU_LOCAL_DESKTOP requires KUDU_LOCAL_MODE=true.");
  }
  const rawLocalDocker = environment.KUDU_LOCAL_DOCKER?.trim().toLowerCase();
  if (rawLocalDocker && rawLocalDocker !== "true" && rawLocalDocker !== "false") {
    throw new Error("KUDU_LOCAL_DOCKER must be true or false.");
  }
  const localDocker = rawLocalDocker === "true";
  if (localDocker && !localMode) {
    throw new Error("KUDU_LOCAL_DOCKER requires KUDU_LOCAL_MODE=true.");
  }
  if (localDocker && localDesktop) {
    throw new Error("Desktop Local and Docker Local modes cannot be enabled together.");
  }
  const isProduction = environment.NODE_ENV?.trim().toLowerCase() === "production";
  if (localMode && isProduction && !localDesktop) {
    throw new Error("KUDU_LOCAL_MODE is only available outside production.");
  }

  const databaseUrl = localMode ? undefined : environment.DATABASE_URL?.trim();
  if (!databaseUrl && !localMode) {
    throw new Error("DATABASE_URL is required. Copy .env.example to .env and configure it.");
  }

  if (databaseUrl) {
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
  }

  const rawPort = environment.PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < (localDesktop ? 0 : 1) || port > 65_535) {
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

  const auth: AuthConfiguration = {
    passwordHash: environment.KUDU_AUTH_PASSWORD_HASH?.trim() || undefined,
    sessionSecret: environment.SESSION_SECRET?.trim() || undefined,
    cookieSecure: rawCookieSecure !== "false",
  };
  const host = environment.HOST?.trim() || "127.0.0.1";
  if (localMode && !["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase())) {
    throw new Error("KUDU_LOCAL_MODE requires HOST to be loopback (127.0.0.1, ::1, or localhost).");
  }
  const rawLocalDockerPort = environment.KUDU_LOCAL_DOCKER_PORT ?? "3000";
  const localDockerPort = Number(rawLocalDockerPort);
  if (!Number.isInteger(localDockerPort) || localDockerPort < 1 || localDockerPort > 65_535) {
    throw new Error("KUDU_LOCAL_DOCKER_PORT must be an integer between 1 and 65535.");
  }
  if (localDocker && localDockerPort === port) {
    throw new Error("KUDU_LOCAL_DOCKER_PORT must differ from the loopback API port.");
  }

  if (isProduction && !localDesktop) {
    if (!new AuthManager(auth).configured) {
      throw new Error(
        "Production requires a valid KUDU_AUTH_PASSWORD_HASH and a SESSION_SECRET of at least 32 bytes.",
      );
    }
    if (!auth.cookieSecure) {
      throw new Error(
        "KUDU_COOKIE_SECURE must be true in production; use HTTPS for remote browser access.",
      );
    }
  }

  return {
    ...(databaseUrl ? { databaseUrl } : {}),
    host,
    port,
    logLevel,
    auth,
    localMode,
    localDesktop,
    localDocker,
    localDockerPort,
  };
}
