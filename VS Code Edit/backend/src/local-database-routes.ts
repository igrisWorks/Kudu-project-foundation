import type { FastifyInstance } from "fastify";
import type { LocalDatabaseManager } from "./local-database.js";

function failure(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, status: number, message: string) {
  return reply.code(status).send({ error: { code: "LOCAL_DATABASE_ERROR", message } });
}

export function registerLocalDatabaseRoutes(app: FastifyInstance, manager: LocalDatabaseManager): void {
  app.get("/api/v1/local/database", async () => manager.status());

  app.post<{ Body: unknown }>("/api/v1/local/database/test", async (request, reply) => {
    let settings;
    try {
      settings = manager.settingsFromInput(request.body);
    } catch (error) {
      return failure(reply, 400, error instanceof Error ? error.message : "Invalid database settings.");
    }
    try {
      await manager.test(settings);
      return { connected: true, message: "PostgreSQL connection succeeded." };
    } catch (error) {
      return failure(reply, 503, error instanceof Error ? error.message : "PostgreSQL connection failed.");
    }
  });

  app.post<{ Body: unknown }>("/api/v1/local/database/save", async (request, reply) => {
    let settings;
    try {
      settings = manager.settingsFromInput(request.body);
    } catch (error) {
      return failure(reply, 400, error instanceof Error ? error.message : "Invalid database settings.");
    }
    try {
      await manager.save(settings);
      return manager.status();
    } catch (error) {
      return failure(reply, 503, error instanceof Error ? error.message : "Database settings could not be saved.");
    }
  });

  app.post<{ Body: unknown }>("/api/v1/local/database/initialize", async (request, reply) => {
    const body = request.body && typeof request.body === "object"
      ? request.body as Record<string, unknown>
      : {};
    if (body.confirm !== true) {
      return failure(reply, 400, "Confirm that Kudu may create only missing PostgreSQL objects.");
    }
    let settings;
    try {
      settings = manager.settingsFromInput(body);
    } catch (error) {
      return failure(reply, 400, error instanceof Error ? error.message : "Invalid database settings.");
    }
    if (typeof body.adminUsername !== "string" || typeof body.adminPassword !== "string") {
      return failure(reply, 400, "Enter PostgreSQL administrator credentials for initialization.");
    }
    try {
      await manager.initializeMissingObjects(settings, body.adminUsername, body.adminPassword);
      return manager.status();
    } catch (error) {
      return failure(reply, 503, error instanceof Error ? error.message : "PostgreSQL initialization failed.");
    }
  });

  app.post("/api/v1/local/database/migrate", async (_request, reply) => {
    try {
      const applied = await manager.migrate();
      return { ...(await manager.status()), applied };
    } catch (error) {
      return failure(reply, 503, error instanceof Error ? error.message : "Database migration failed.");
    }
  });
}
