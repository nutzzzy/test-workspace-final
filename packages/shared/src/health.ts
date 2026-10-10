export type HealthStatus = "ok" | "degraded" | "down";

export type ServiceHealth = {
  name: string;
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
};

export type HealthResponse = {
  status: HealthStatus;
  version: string;
  timestamp: string;
  services: ServiceHealth[];
};
