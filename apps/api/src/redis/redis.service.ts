import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private warned = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>("REDIS_URL", "redis://localhost:6379");
    this.client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      reconnectOnError: () => false,
    });

    this.client.on("error", (err) => {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `Redis unavailable (${err.message}). Continuing without Redis.`,
        );
      }
    });
  }

  async onModuleDestroy() {
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  async ping(): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
    if (!this.client) {
      return { ok: false, message: "Redis client not initialized" };
    }

    const started = Date.now();
    try {
      if (this.client.status !== "ready" && this.client.status !== "connecting") {
        await this.client.connect();
      }
      const result = await this.client.ping();
      return {
        ok: result === "PONG",
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : "Redis ping failed",
      };
    }
  }
}
