import { HealthService } from "./health.service";

describe("HealthService", () => {
  it("aggregates ok when all services are healthy", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    };
    const redis = {
      ping: jest.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    };

    const service = new HealthService(prisma as never, redis as never);
    const result = await service.check();

    expect(result.status).toBe("ok");
    expect(result.services).toHaveLength(2);
    expect(result.services.every((s) => s.status === "ok")).toBe(true);
  });

  it("returns degraded when postgres is down and redis is up", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error("connection refused")),
    };
    const redis = {
      ping: jest.fn().mockResolvedValue({ ok: true, latencyMs: 2 }),
    };

    const service = new HealthService(prisma as never, redis as never);
    const result = await service.check();

    expect(result.status).toBe("degraded");
    expect(result.services.find((s) => s.name === "postgres")?.status).toBe(
      "down",
    );
  });

  it("returns down when all services fail", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error("db down")),
    };
    const redis = {
      ping: jest
        .fn()
        .mockResolvedValue({ ok: false, message: "redis down", latencyMs: 3 }),
    };

    const service = new HealthService(prisma as never, redis as never);
    const result = await service.check();

    expect(result.status).toBe("down");
  });
});
