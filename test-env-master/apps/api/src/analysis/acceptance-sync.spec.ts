import { planCriteriaSync } from "./acceptance-sync";

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
