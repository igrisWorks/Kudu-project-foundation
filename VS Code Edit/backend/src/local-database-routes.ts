import type { FastifyInstance } from "fastify";
import type { LocalDatabaseManager } from "./local-database.js";

function failure(
  reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  status: number,
  message: string,
) {
  return reply.code(status).send({ error: { code: "LOCAL_DATABASE_ERROR", message } });
}

export function registerLocalDatabaseRoutes(app: FastifyInstance, manager: LocalDatabaseManager): void {
  app.get("/api/v1/local/database", async () => manager.status());
  app.get("/api/v1/local/database/backups", async () => ({ items: await manager.listBackups() }));

  app.post("/api/v1/local/database/backups", async (_request, reply) => {
    try {
      return reply.code(201).send({ backup: await manager.createBackup() });
    } catch (error) {
      return failure(reply, 500, error instanceof Error ? error.message : "A database backup could not be created.");
    }
  });

  app.post<{ Body: unknown }>("/api/v1/local/database/restore", async (request, reply) => {
    const body = request.body && typeof request.body === "object"
      ? request.body as Record<string, unknown>
      : {};
    if (body.confirm !== true) {
      return failure(reply, 400, "Confirm that restoring the selected backup will replace current local data.");
    }
    if (typeof body.backupName !== "string") {
      return failure(reply, 400, "Choose a KuduNS backup to restore.");
    }
    try {
      return {
        ...(await manager.restoreBackup(body.backupName)),
        status: await manager.status(),
      };
    } catch (error) {
      return failure(reply, 400, error instanceof Error ? error.message : "The selected backup could not be restored.");
    }
  });
}
