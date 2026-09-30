import { Prisma } from "@prisma/client";
import { prismaToHttp } from "./api-exception.filter";

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError("raw prisma text", { code, clientVersion: "test" });

describe("prismaToHttp", () => {
  it("maps request-caused Prisma errors to actionable 4xx responses", () => {
    expect(prismaToHttp(known("P2025"))?.status).toBe(404);
    expect(prismaToHttp(known("P2002"))?.status).toBe(409);
    expect(prismaToHttp(known("P2003"))?.status).toBe(400);
    expect(prismaToHttp(known("P2025"))?.message).not.toMatch(/prisma/i);
  });

  it("leaves unknown errors to the generic handler", () => {
    expect(prismaToHttp(known("P1001"))).toBeNull();
    expect(prismaToHttp(new Error("x"))).toBeNull();
  });
});
