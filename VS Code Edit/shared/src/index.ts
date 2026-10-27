export interface HealthResponse {
  status: "ok" | "degraded";
  database: "connected" | "unavailable";
  checkedAt: string;
}
