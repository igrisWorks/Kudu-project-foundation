import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { HealthResponse } from "@kudu/shared";
import type { Database } from "./database.js";
import { checkDatabase } from "./database.js";
import type { Kysely } from "kysely";

interface AppOptions {
  db: Kysely<Database>;
  staticDirectory?: string;
  logLevel?: string;
  databaseCheck?: (db: Kysely<Database>) => Promise<void>;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? process.env.LOG_LEVEL ?? "info",
    },
    trustProxy: false,
  });
  const databaseCheck = options.databaseCheck ?? checkDatabase;

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

  if (options.staticDirectory) {
    try {
      await access(join(options.staticDirectory, "index.html"));
      await app.register(fastifyStatic, {
        root: options.staticDirectory,
        prefix: "/",
        index: ["index.html"],
      });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
          return reply.sendFile("index.html");
        }
        return reply.code(404).send({ error: "Not found" });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return app;
}
