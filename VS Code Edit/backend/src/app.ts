import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HealthResponse } from "@kudu/shared";
import type { Database } from "./database.js";
import { checkDatabase } from "./database.js";
import { ApiFailure } from "./errors.js";
import { registerEventRoutes } from "./events.js";
import { registerFileImportRoutes } from "./file-import.js";
import { registerEventMappingRoutes } from "./event-mappings.js";
import { registerRegistryRoutes } from "./registry.js";
import { registerRestSyncRoutes } from "./rest-sync.js";
import type { Kysely } from "kysely";
import { AuthManager, registerAuthenticationGuard, registerAuthRoutes, type AuthConfiguration } from "./auth.js";
import { registerLocalDatabaseRoutes } from "./local-database-routes.js";
import type { LocalDatabaseManager } from "./local-database.js";

interface AppOptions {
  db: Kysely<Database>;
  staticDirectory?: string;
  logLevel?: string;
  importDirectory?: string;
  restTrustedHosts?: string[];
  allowLoopbackRestTests?: boolean;
  databaseCheck?: (db: Kysely<Database>) => Promise<void>;
  auth?: AuthConfiguration;
  localMode?: boolean;
  localDocker?: boolean;
  localDatabase?: LocalDatabaseManager;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "req.headers['x-kudu-csrf']",
          "req.body.password",
          "req.body.database.password",
          "req.body.adminPassword",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: false,
  });
  const databaseCheck = options.databaseCheck ?? checkDatabase;
  let staticFrontendAvailable = false;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiFailure) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      });
    }

    const databaseErrorCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (databaseErrorCode === "23505") {
      return reply.code(409).send({
        error: {
          code: "DUPLICATE_KEY",
          message: "A record with that key already exists.",
        },
      });
    }
    if (databaseErrorCode === "23503") {
      return reply.code(409).send({
        error: {
          code: "REFERENCED_RECORD",
          message: "This record is referenced by another record.",
        },
      });
    }
    if (databaseErrorCode === "23514") {
      return reply.code(400).send({
        error: {
          code: "INVALID_RECORD",
          message: "The record does not meet the data constraints.",
        },
      });
    }
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    if (statusCode === 400) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request could not be understood.",
        },
      });
    }

    app.log.error({ code: databaseErrorCode }, "Unhandled request failure");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected server error occurred.",
      },
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get<{ Reply: HealthResponse | { error: string } }>(
    "/api/v1/health",
    async (_request, reply) => {
      try {
        await databaseCheck(options.db);
        return reply.code(200).send({
          status: "ok",
          database: "connected",
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        const code =
          error instanceof Error && "code" in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        app.log.warn({ code }, "Database readiness check failed");
        return reply.code(503).send({
          status: "degraded",
          database: "unavailable",
          checkedAt: new Date().toISOString(),
        });
      }
    },
  );

  const auth = new AuthManager(options.auth ?? {
    passwordHash: process.env.KUDU_AUTH_PASSWORD_HASH,
    sessionSecret: process.env.SESSION_SECRET,
    cookieSecure: process.env.KUDU_COOKIE_SECURE?.trim().toLowerCase() !== "false",
  });
  registerAuthenticationGuard(app, auth, { localMode: options.localMode });
  registerAuthRoutes(app, auth, {
    localMode: options.localMode,
    localDocker: options.localDocker,
  });
  if (options.localMode && options.localDatabase) {
    registerLocalDatabaseRoutes(app, options.localDatabase);
  }
  registerRegistryRoutes(app, options.db);
  registerEventRoutes(app, options.db);
  registerEventMappingRoutes(app, options.db);
  registerRestSyncRoutes(app, options.db, {
    trustedHosts: options.restTrustedHosts,
    allowLoopbackForTests: options.allowLoopbackRestTests === true,
  });
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const importDirectory = resolve(
    projectRoot,
    options.importDirectory ?? process.env.KUDU_IMPORT_DIRECTORY ?? "imports",
  );
  registerFileImportRoutes(app, options.db, importDirectory);

  if (options.staticDirectory) {
    try {
      await access(join(options.staticDirectory, "index.html"));
      await app.register(fastifyStatic, {
        root: options.staticDirectory,
        prefix: "/",
        index: ["index.html"],
      });
      staticFrontendAvailable = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  app.setNotFoundHandler((request, reply) => {
    if (
      staticFrontendAvailable &&
      request.method === "GET" &&
      request.headers.accept?.includes("text/html")
    ) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    });
  });

  return app;
}
