import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../../prisma/prisma.service";
import { sessionStatus, UiSessionStore, type StorageState } from "./saved-sessions";

/** The settings table, in memory. */
function store() {
  const rows = new Map<string, { key: string; value: string; updatedAt: Date }>();
  const prisma = {
    systemSetting: {
      findMany: async ({ where }: { where: { key: { startsWith: string } } }) => [...rows.values()].filter((row) => row.key.startsWith(where.key.startsWith)),
      findUnique: async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null,
      count: async () => rows.size,
      create: async ({ data }: { data: { key: string; value: string } }) => rows.set(data.key, { ...data, updatedAt: new Date() }).get(data.key),
      update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
        const row = rows.get(where.key)!;
        row.value = data.value;
        return row;
      },
      delete: async ({ where }: { where: { key: string } }) => {
        if (!rows.delete(where.key)) throw new Error("not found");
        return {};
      },
    },
  } as unknown as PrismaService;
  const config = { get: () => "unit-test-secrets-key" } as unknown as ConfigService;
  return { sessions: new UiSessionStore(prisma, config), rows };
}

const inAnHour = Math.floor(Date.now() / 1000) + 3600;
const state: StorageState = {
  cookies: [
    { name: "sid", value: "very-secret-cookie", domain: "app.example.com", path: "/", expires: inAnHour, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "pref", value: "dark", domain: ".app.example.com", path: "/", expires: inAnHour + 100, httpOnly: false, secure: false, sameSite: "Lax" },
  ],
  origins: [{ origin: "https://app.example.com", localStorage: [{ name: "token", value: "jwt-secret-token" }] }],
};

describe("saved sessions", () => {
  it("saves a session encrypted and shows only a summary", async () => {
    const { sessions, rows } = store();
    const saved = await sessions.create("Customer Login", state);
    expect(saved).toMatchObject({ name: "Customer Login", domain: "app.example.com", cookies: 2, cookieNames: ["sid", "pref"], storage: 1, status: "valid" });
    // No value anywhere: not in the summary, not readable in the stored row.
    for (const text of [JSON.stringify(saved), JSON.stringify(await sessions.list()), [...rows.values()][0]!.value]) {
      expect(text).not.toContain("very-secret-cookie");
      expect(text).not.toContain("jwt-secret-token");
    }
    expect(JSON.stringify(saved)).not.toContain("stateEnc");
    // The replay gets the real state back.
    expect(await sessions.state(saved.id)).toEqual(state);
  });

  it("saves cookies only when asked, renames, lists and deletes (state included)", async () => {
    const { sessions, rows } = store();
    const saved = await sessions.create("Admin", state, { cookiesOnly: true });
    expect(saved.storage).toBe(0);
    expect((await sessions.state(saved.id))!.origins).toEqual([]);
    expect((await sessions.rename(saved.id, "Admin (staging)")).name).toBe("Admin (staging)");
    expect((await sessions.list()).map((item) => item.name)).toEqual(["Admin (staging)"]);
    await sessions.remove(saved.id);
    expect(rows.size).toBe(0);
    expect(await sessions.state(saved.id)).toBeNull();
    await expect(sessions.remove(saved.id)).rejects.toThrow(/not found/);
  });

  it("refuses an empty browser and an empty name", async () => {
    const { sessions } = store();
    await expect(sessions.create("x", { cookies: [], origins: [] })).rejects.toThrow(/sign in first/);
    await expect(sessions.create("  ", state)).rejects.toThrow(/Name/);
  });

  it("tells valid, expired and unknown apart", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(sessionStatus(state)).toBe("valid");
    expect(sessionStatus({ cookies: state.cookies.map((cookie) => ({ ...cookie, expires: past })), origins: [] })).toBe("expired");
    // Expired cookies but a stored token: only opening the app tells.
    expect(sessionStatus({ cookies: state.cookies.map((cookie) => ({ ...cookie, expires: past })), origins: state.origins })).toBe("unknown");
    // Browser-session cookies have no expiry.
    expect(sessionStatus({ cookies: [{ ...state.cookies[0]!, expires: -1 }], origins: [] })).toBe("unknown");
  });
});
