import { Injectable } from "@nestjs/common";
import type { HealthResponse, HealthStatus, ServiceHealth } from "@qa-workbench/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthResponse> {
    const services: ServiceHealth[] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);

    const status = this.aggregateStatus(services);

    return {
      status,
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      services,
    };
  }

  private async checkPostgres(): Promise<ServiceHealth> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        name: "postgres",
        status: "ok",
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        name: "postgres",
        status: "down",
        latencyMs: Date.now() - started,
        message:
          error instanceof Error ? error.message : "PostgreSQL unreachable",
      };
    }
  }

  private async checkRedis(): Promise<ServiceHealth> {
    const result = await this.redis.ping();
    return {
      name: "redis",
      status: result.ok ? "ok" : "down",
      latencyMs: result.latencyMs,
      message: result.message,
    };
  }

  private aggregateStatus(services: ServiceHealth[]): HealthStatus {
    if (services.every((s) => s.status === "ok")) return "ok";
    if (services.some((s) => s.status === "ok")) return "degraded";
    return "down";
  }
}
