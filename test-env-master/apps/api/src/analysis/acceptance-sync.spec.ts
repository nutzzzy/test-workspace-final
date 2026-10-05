import { planCriteriaSync, syncAcceptanceCriteria } from "./acceptance-sync";

const row = (id: string, key: string, text: string) => ({ id, key, text });
const next = (key: string, text: string, orderIndex: number) => ({ key, text, orderIndex });

describe("planCriteriaSync", () => {
  it("keeps every row when only keys are re-formatted (AC-1 → AC-01)", () => {
    const plan = planCriteriaSync(
      [row("a", "AC-1", "User can log in"), row("b", "AC-2", "User can log out")],
      [next("AC-01", "User can log in", 0), next("AC-02", "User can log out", 1)],
    );
    expect(plan.keep.map((k) => k.id)).toEqual(["a", "b"]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("follows the text, not the position, when a criterion is inserted first", () => {
    const plan = planCriteriaSync(
      [row("login", "AC-01", "User can log in")],
      [next("AC-01", "User can register", 0), next("AC-02", "User can log in", 1)],
    );
    expect(plan.keep).toEqual([{ id: "login", next: next("AC-02", "User can log in", 1) }]);
    expect(plan.create).toEqual([next("AC-01", "User can register", 0)]);
    expect(plan.remove).toEqual([]);
  });

  it("treats a same-length rewording as an edit in place", () => {
    const plan = planCriteriaSync(
      [row("a", "AC-1", "User can log in"), row("b", "AC-2", "Show errors")],
      [next("AC-1", "User can log in", 0), next("AC-2", "Show a clear error message", 1)],
    );
    expect(plan.keep.map((k) => k.id)).toEqual(["a", "b"]);
    expect(plan.remove).toEqual([]);
  });

  it("never matches by substring", () => {
    const plan = planCriteriaSync(
      [row("a", "AC-1", "Login"), row("b", "AC-2", "Logout")],
      [next("AC-1", "Login with SSO is supported", 0)],
    );
    expect(plan.keep).toEqual([]);
    expect(plan.create).toHaveLength(1);
    expect(plan.remove.sort()).toEqual(["a", "b"]);
  });

  it("ignores whitespace and case differences", () => {
    const plan = planCriteriaSync([row("a", "AC-1", "User  can LOG in")], [next("AC-1", "user can log in", 0)]);
    expect(plan.keep.map((k) => k.id)).toEqual(["a"]);
  });
});

describe("syncAcceptanceCriteria", () => {
  it("rebuilds only the criteria that came from Jira; the workspace's own stay", async () => {
    let rows = [
      { id: "j1", key: "AC-01", text: "Old Jira text", origin: "imported", orderIndex: 0 },
      { id: "ai", key: "AI-01", text: "AI proposal", origin: "ai", orderIndex: 1 },
      { id: "ok", key: "AI-02", text: "Confirmed proposal", origin: "confirmed", orderIndex: 2 },
      { id: "me", key: "M-01", text: "Written by the user", origin: "manual", orderIndex: 3 },
      { id: "junk", key: "AC-02", text: "کاربر بتواند created_at DATETIME", origin: "derived", orderIndex: 4 },
    ];
    const tx = {
      acceptanceCriterion: {
        findMany: async ({ where }: { where: { origin: { in: string[] } } }) => rows.filter((row) => where.origin.in.includes(row.origin)),
        deleteMany: async ({ where }: { where: { id?: { in: string[] }; origin?: string } }) => {
          rows = rows.filter((row) => !(where.id?.in.includes(row.id) || (where.origin && row.origin === where.origin)));
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((row) => row.id === where.id)!, data),
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          rows.push(...data.map((item, index) => ({ id: `new${index}`, origin: "imported", ...item }) as (typeof rows)[number]));
        },
      },
    } as never;
    await syncAcceptanceCriteria(tx, "issue", [
      { key: "AC-01", text: "Old Jira text", orderIndex: 0, origin: "imported" },
      { key: "AC-02", text: "New Jira criterion", orderIndex: 1, origin: "imported" },
    ]);
    expect(rows.map((row) => `${row.key}:${row.origin}`).sort()).toEqual(["AC-01:imported", "AC-02:imported", "AI-01:ai", "AI-02:confirmed", "M-01:manual"]);
    expect(rows.find((row) => row.key === "AC-02")!.text).toBe("New Jira criterion");
  });
});
