import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { UiFlowExecutor, type UiActionResult, type UiFlowDeps } from "../executors/ui-flow.executor";
import { orchestrateSteps, type LiveStepProgress } from "../orchestrate";
import { StepExecutorRegistry } from "../step-executor.registry";
import { ExecutionContext } from "../types";
import { sessionStatus, summarize, type StorageState } from "./saved-sessions";
import { browserPath, type AiResolver } from "./ui-browser";
import { UiRecorderService } from "./ui-recorder.service";
import { readUiConfig, type UiAction } from "./ui-types";

/**
 * Resilient locators and saved sessions, in a real browser: a users table
 * recorded once and replayed after its rows moved, its markup changed, its
 * ids were regenerated; look-alike buttons; a saved sign-in. Skipped where
 * no Chrome/Chromium is installed.
 */
const hasBrowser = Boolean(browserPath());
const describeUi = hasBrowser ? describe : describe.skip;
jest.setTimeout(120_000);

const PEOPLE = [
  { name: "Ali", email: "ali@example.test" },
  { name: "Reza", email: "reza@example.test" },
  { name: "Sara", email: "sara@example.test" },
  { name: "Mina", email: "mina@example.test" },
  { name: "John", email: "john@example.test" },
];

/** How the users page looks now. */
let layout: { order: number[]; restyled: boolean; dynamicIds: boolean; extraSara: boolean } = { order: [0, 1, 2, 3, 4], restyled: false, dynamicIds: false, extraSara: false };

function usersPage() {
  const people = layout.order.map((index) => PEOPLE[index]!);
  if (layout.extraSara) people.push({ name: "Sara", email: "sara.k@example.test" });
  const rows = people
    .map((person) => {
      const id = layout.dynamicIds ? `${Math.random().toString(16).slice(2)}-${Date.now()}` : "";
      const buttons = layout.restyled
        ? `<div class="x9-actions"><span class="wrap"><button class="btn-k82 primary" data-email="${person.email}">Edit</button></span><button class="btn-k83" data-email="${person.email}">Delete</button></div>`
        : `<button class="edit" data-email="${person.email}">Edit</button> <button class="del" data-email="${person.email}">Delete</button>`;
      return `<tr${id ? ` data-row-id="${id}"` : ""}><td>${person.name}</td><td>${person.email}</td><td>${buttons}</td></tr>`;
    })
    .join("");
  return `<!doctype html><html><body>
    <h2>Users</h2>
    <table class="${layout.restyled ? "grid-v2" : "users"}"><thead><tr><th>Name</th><th>Email</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
    <p id="out"></p>
    <script>
      document.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (button) document.getElementById("out").textContent = button.textContent + " " + button.dataset.email;
      });
    </script></body></html>`;
}

/** Two «Save» buttons in named sections; `bare` drops the section names. */
const savePage = (bare: boolean) => `<!doctype html><html><body>
  <section ${bare ? "" : 'aria-label="Billing"'}><h3>${bare ? "" : "Billing"}</h3><button onclick="out.textContent='billing'">Save</button></section>
  <section ${bare ? "" : 'aria-label="Shipping"'}><h3>${bare ? "" : "Shipping"}</h3><button onclick="out.textContent='shipping'">Save</button></section>
  <p id="out"></p></body></html>`;

let server: Server;
let base: string;

beforeAll(async () => {
  if (!hasBrowser) return;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { "content-type": "text/html", ...headers });
      res.end(body);
    };
    if (url.pathname === "/users") return html(usersPage());
    if (url.pathname === "/save") return html(savePage(url.searchParams.get("bare") === "1"));
    // Sign-in: a session cookie, a dashboard behind it, the sign-in page for everyone else.
    if (url.pathname === "/auth/login") {
      return html(`<form action="/auth/do" method="post"><label>Password <input type="password" name="p"></label><button>Sign in</button></form>`);
    }
    if (url.pathname === "/auth/do") {
      const expires = new Date(Date.now() + 3600_000).toUTCString();
      res.writeHead(302, { location: "/app", "set-cookie": `sid=secret-session-value-123; Path=/; Expires=${expires}` });
      return res.end();
    }
    if (url.pathname === "/app") {
      if (!/sid=secret-session-value-123/.test(req.headers.cookie ?? "")) {
        res.writeHead(302, { location: "/auth/login" });
        return res.end();
      }
      return html(`<h1>Dashboard</h1><button onclick="out.textContent='opened'">Open report</button><p id="out"></p>`);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Record clicks on the users page like a user. */
async function record(path: string, clicks: string[]) {
  const recorder = new UiRecorderService();
  const started = await recorder.start({ scenarioId: "s", startUrl: `${base}${path}` }, { headless: true });
  for (const selector of clicks) {
    await started.page.click(selector);
    await started.page.waitForTimeout(150);
  }
  await recorder.stop(started.id);
  return recorder.take(started.id).actions;
}

async function replay(path: string, actions: UiAction[], deps: UiFlowDeps = {}, extra: Record<string, unknown> = {}) {
  const context = new ExecutionContext();
  try {
    const result = await new UiFlowExecutor((value) => value, deps).execute(
      { startUrl: `${base}${path}`, actions: actions.map((action) => ({ ...action })), actionTimeoutMs: 2_500, ...extra },
      context,
    );
    const output = (result.output ?? {}) as { actions?: UiActionResult[]; errorCode?: string; body?: unknown };
    return { result, actions: output.actions ?? [], errorCode: output.errorCode, out: await lastOut(context) };
  } finally {
    await context.dispose();
  }
}

/** What the page printed (#out) at the end of the replay. */
async function lastOut(context: ExecutionContext) {
  const session = context.resources.get("ui-session") as { page: import("playwright-core").Page } | undefined;
  return session ? await session.page.locator("#out").textContent().catch(() => null) : null;
}

const editIn = (index: number) => `tbody tr:nth-child(${index}) button:has-text("Edit")`;

describeUi("table rows: the row the user acted in, not its position", () => {
  beforeEach(() => {
    layout = { order: [0, 1, 2, 3, 4], restyled: false, dynamicIds: false, extraSara: false };
  });

  it("records the row by a unique cell value and the button by role, with confidence", async () => {
    const [click] = await record("/users", [editIn(3)]);
    const scope = click!.target!.scope!;
    expect(scope.rowCount).toBe(5);
    expect(scope.container).toMatchObject({ role: "table", name: "Users" });
    // Sara's name first (a name column is preferred), her email as a second way.
    expect(scope.identity[0]).toMatchObject({ strategy: "cell", column: "Name", value: "Sara" });
    expect(scope.identity.some((item) => item.strategy === "index")).toBe(false);
    expect(scope.target[0]).toMatchObject({ kind: "role", value: "button", name: "Edit", unique: true });
    expect(scope.target[0]!.confidence).toBeGreaterThan(0.8);
    // Page-wide, «Edit» is one of five: kept for context, scored low, never presented as unique.
    const pageWide = click!.target!.candidates.find((candidate) => candidate.kind === "role");
    expect(pageWide).toMatchObject({ unique: false });
    expect(pageWide!.confidence!).toBeLessThan(0.5);
    expect(click!.label).toBe("Click «Edit» in row «Sara»");
  });

  it.each([
    [1, "ali@example.test"],
    [3, "sara@example.test"],
    [5, "john@example.test"],
  ])("replays a click in row %i on that same row", async (row, email) => {
    const actions = await record("/users", [editIn(row)]);
    const { result, out } = await replay("/users", actions);
    expect(result.status).toBe("PASSED");
    expect(out).toBe(`Edit ${email}`);
  });

  it("finds the same person after the rows were reordered", async () => {
    const actions = await record("/users", [editIn(3)]);
    layout.order = [4, 3, 2, 0, 1].reverse(); // Reza, Ali, Sara, Mina, John → Sara is now somewhere else
    layout.order = [1, 0, 4, 2, 3]; // Reza, Ali, John, Sara, Mina
    const { result, out, actions: steps } = await replay("/users", actions);
    expect(result.status).toBe("PASSED");
    expect(out).toBe("Edit sara@example.test");
    expect(steps[0]!.how).toMatch(/in row Name=«Sara»/);
  });

  it("survives changed CSS classes and deeper nesting of the buttons", async () => {
    const actions = await record("/users", [editIn(4)]);
    layout.restyled = true;
    const { result, out } = await replay("/users", actions);
    expect(result.status).toBe("PASSED");
    expect(out).toBe("Edit mina@example.test");
  });

  it("uses a second column when a name appears twice", async () => {
    layout.extraSara = true;
    const actions = await record("/users", [editIn(6)]);
    const identity = actions[0]!.target!.scope!.identity;
    // «Sara» is not unique: her email is.
    expect(identity[0]).toMatchObject({ strategy: "cell", column: "Email", value: "sara.k@example.test" });
    layout.order = [2, 0, 1, 3, 4];
    const { result, out } = await replay("/users", actions);
    expect(result.status).toBe("PASSED");
    expect(out).toBe("Edit sara.k@example.test");
  });

  it("does not trust generated row ids: they change, the cell value still finds the row", async () => {
    layout.dynamicIds = true;
    const actions = await record("/users", [editIn(2)]);
    const identity = actions[0]!.target!.scope!.identity;
    expect(identity[0]).toMatchObject({ strategy: "attr", attr: "data-row-id" });
    expect(identity.some((item) => item.strategy === "cell" && item.value === "Reza")).toBe(true);
    layout.order = [4, 3, 2, 1, 0];
    const { result, out, actions: steps } = await replay("/users", actions);
    expect(result.status).toBe("PASSED");
    expect(out).toBe("Edit reza@example.test");
    expect(steps[0]!.status).toBe("PASSED");
  });

  it("fails safely when two rows fit the recorded identity: AMBIGUOUS_LOCATOR, nothing clicked", async () => {
    const actions = await record("/users", [editIn(3)]);
    // Keep only the name: two «Sara» rows now fit it.
    const only = actions.map((action) => ({ ...action, target: { ...action.target!, scope: { ...action.target!.scope!, identity: [{ strategy: "cell" as const, column: "Name", value: "Sara" }] } } }));
    layout.extraSara = true;
    const { result, errorCode, out, actions: steps } = await replay("/users", only);
    expect(result.status).toBe("FAILED");
    expect(errorCode).toBe("AMBIGUOUS_LOCATOR");
    expect(steps[0]!.diagnostics).toMatchObject({ rows: 6 });
    expect(out).toBe("");
  });

  it("reports ELEMENT_NOT_FOUND (with what it saw) when the person is gone", async () => {
    const actions = await record("/users", [editIn(3)]);
    layout.order = [0, 1, 3, 4];
    const { result, errorCode, actions: steps } = await replay("/users", actions);
    expect(result.status).toBe("FAILED");
    expect(errorCode).toBe("ELEMENT_NOT_FOUND");
    expect(steps[0]!.error).toMatch(/^Element not found: no row matches/);
    expect(steps[0]!.diagnostics).toMatchObject({ rows: 4 });
  });
});

describeUi("look-alike elements outside tables", () => {
  it("tells two identical buttons apart by the named section they are in", async () => {
    const actions = await record("/save", ['section[aria-label="Shipping"] button']);
    expect(actions[0]!.target!.context).toEqual({ role: "region", name: "Shipping" });
    const { result, out, actions: steps } = await replay("/save", actions);
    expect(result.status).toBe("PASSED");
    expect(out).toBe("shipping");
    expect(steps[0]!.how).toMatch(/in «Shipping»/);
  });

  it("fails with AMBIGUOUS_LOCATOR instead of clicking the first match", async () => {
    const actions = await record("/save?bare=1", ["section:nth-of-type(2) button"]);
    const { result, errorCode, out } = await replay("/save?bare=1", actions);
    expect(result.status).toBe("FAILED");
    expect(errorCode).toBe("AMBIGUOUS_LOCATOR");
    expect(out).toBe("");
  });

  it("asks the AI only when the options differ, and caches nothing it was not asked", async () => {
    const actions = await record("/save", ['section[aria-label="Billing"] button']);
    // The named regions are gone, but the section headings still tell them apart: a case for the AI.
    const stripped = actions.map((action) => ({ ...action, target: { ...action.target!, context: undefined } }));
    const questions: Array<Parameters<AiResolver>[0]> = [];
    const ai: AiResolver = async (question) => {
      questions.push(question);
      return { index: question.options.findIndex((text) => /Billing/.test(text)), confidence: 0.95 };
    };
    const { result, out } = await replay("/save", stripped, { ai });
    expect(result.status).toBe("PASSED");
    expect(out).toBe("billing");
    expect(questions).toHaveLength(1);
    // Only short summaries were sent, never the page.
    expect(JSON.stringify(questions[0]).length).toBeLessThan(800);
    // Identical options: the AI is not even asked.
    const bare = await record("/save?bare=1", ["section:nth-of-type(1) button"]);
    questions.length = 0;
    const again = await replay("/save?bare=1", bare, { ai });
    expect(again.errorCode).toBe("AMBIGUOUS_LOCATOR");
    expect(questions).toHaveLength(0);
  });

  it("replays a legacy action that only has a CSS selector, and falls back between locators", async () => {
    layout = { order: [0, 1, 2, 3, 4], restyled: false, dynamicIds: false, extraSara: false };
    const legacy = [{ id: "old-1", kind: "click", selector: 'button.edit[data-email="mina@example.test"]', label: "Edit Mina" }] as unknown as UiAction[];
    const migrated = readUiConfig({ startUrl: `${base}/users`, actions: legacy });
    expect(migrated.ok && migrated.value.actions[0]!.target!.candidates[0]).toMatchObject({ kind: "css", value: 'button.edit[data-email="mina@example.test"]' });
    const { result, out } = await replay("/users", legacy);
    expect(result.status).toBe("PASSED");
    expect(out).toBe("Edit mina@example.test");
    // A first locator that no longer works: the next one is used.
    const fallback = [
      {
        id: "f-1",
        kind: "click",
        target: {
          candidates: [
            { kind: "testid", value: '[data-testid="gone"]', unique: true },
            { kind: "css", value: 'button.del[data-email="john@example.test"]', unique: true },
          ],
          fingerprint: { tag: "button" },
        },
      },
    ] as unknown as UiAction[];
    const second = await replay("/users", fallback);
    expect(second.result.status).toBe("PASSED");
    expect(second.out).toBe("Delete john@example.test");
  });
});

describeUi("saved sessions", () => {
  /** Sign in by hand in the recording browser, then keep its session. */
  async function signedInState(): Promise<StorageState> {
    const recorder = new UiRecorderService();
    const started = await recorder.start({ scenarioId: "s", startUrl: `${base}/auth/login` }, { headless: true });
    await started.page.fill('input[type="password"]', "pw");
    await started.page.click("button");
    await started.page.waitForURL(/\/app$/);
    await recorder.stop(started.id);
    // Still available after the browser closed.
    const state = await recorder.storageState(started.id);
    await recorder.discard(started.id);
    return state;
  }

  it("saves cookies without passwords and summarises them without values", async () => {
    const state = await signedInState();
    expect(state.cookies.map((cookie) => cookie.name)).toEqual(["sid"]);
    expect(JSON.stringify(state)).not.toContain('"pw"');
    const summary = summarize(state);
    expect(summary).toMatchObject({ cookies: 1, cookieNames: ["sid"], domain: "127.0.0.1" });
    expect(JSON.stringify(summary)).not.toContain("secret-session-value");
    expect(sessionStatus(state)).toBe("valid");
  });

  it("replays signed in with the selected session: no sign-in page, the action works", async () => {
    const state = await signedInState();
    const actions = await (async () => {
      const recorder = new UiRecorderService();
      const started = await recorder.start({ scenarioId: "s", startUrl: `${base}/app` }, { headless: true, storageState: state });
      await started.page.click("text=Open report");
      await started.page.waitForTimeout(150);
      await recorder.stop(started.id);
      return recorder.take(started.id).actions;
    })();
    const loads: string[] = [];
    const { result, out } = await replay(
      "/app",
      actions,
      { loadSession: async (id) => (loads.push(id), state) },
      { session: { savedSessionId: "customer", useSavedSession: true } },
    );
    expect(loads).toEqual(["customer"]);
    expect(result.status).toBe("PASSED");
    expect(out).toBe("opened");
    // Without the session the same replay lands on the sign-in page.
    const signedOut = await replay("/app", actions, {}, {});
    expect(signedOut.result.status).toBe("FAILED");
  });

  it("reports AUTHENTICATION_STATE_EXPIRED — not ELEMENT_NOT_FOUND — for an expired or missing session", async () => {
    const state = await signedInState();
    const actions = [{ id: "a1", kind: "click", target: { candidates: [{ kind: "role", value: "button", name: "Open report", unique: true }], fingerprint: { tag: "button" } } }] as unknown as UiAction[];
    const session = { session: { savedSessionId: "customer", useSavedSession: true } };
    // Cookies expired on paper: refused before anything opens.
    const expired = { ...state, cookies: state.cookies.map((cookie) => ({ ...cookie, expires: Math.floor(Date.now() / 1000) - 60 })) };
    const early = await replay("/app", actions, { loadSession: async () => expired }, session);
    expect(early.result.status).toBe("FAILED");
    expect(early.errorCode).toBe("AUTHENTICATION_STATE_EXPIRED");
    expect(early.result.error).toMatch(/^AUTHENTICATION_STATE_EXPIRED/);
    // Still valid on paper, but the server no longer accepts it: sent to the sign-in page.
    const revoked = { ...state, cookies: state.cookies.map((cookie) => ({ ...cookie, value: "revoked" })) };
    const late = await replay("/app", actions, { loadSession: async () => revoked }, session);
    expect(late.errorCode).toBe("AUTHENTICATION_STATE_EXPIRED");
    expect(late.result.error).toMatch(/sign-in page/);
    // A deleted session.
    const gone = await replay("/app", actions, { loadSession: async () => null }, session);
    expect(gone.errorCode).toBe("AUTHENTICATION_STATE_EXPIRED");
    // Turned off on the step: not used even though one is chosen.
    const off = await replay("/app", actions, { loadSession: async () => state }, { session: { savedSessionId: "customer", useSavedSession: false } });
    expect(off.errorCode).not.toBe("AUTHENTICATION_STATE_EXPIRED");
  });
});

describeUi("live progress of a running UI step", () => {
  it("reports the browser start, the start page and each action as it runs, through the run's live view", async () => {
    layout = { order: [0, 1, 2, 3, 4], restyled: false, dynamicIds: false, extraSara: false };
    const actions = await record("/users", [editIn(1), editIn(2)]);
    const registry = new StepExecutorRegistry();
    registry.register(new UiFlowExecutor((value) => value));
    const seen: LiveStepProgress[] = [];
    const context = new ExecutionContext();
    try {
      await orchestrateSteps(
        [{ id: "ui-1", name: "Edit users", type: "UI_FLOW", enabled: true, orderIndex: 0, config: { startUrl: `${base}/users`, actions } }],
        registry,
        context,
        { stopOnFailure: true, onProgress: (progress) => void seen.push(progress) },
      );
    } finally {
      await context.dispose();
    }
    const ui = seen.filter((item) => item.ui).map((item) => item.ui!);
    expect(seen[0]).toMatchObject({ stepId: "ui-1", state: "RUNNING" });
    expect(ui[0]).toMatchObject({ phase: "starting", current: 0, total: 2 });
    expect(ui.map((item) => item.phase)).toEqual(expect.arrayContaining(["starting", "opening", "actions", "finishing"]));
    // Action 1 runs, then passes while action 2 runs.
    const first = ui.find((item) => item.actions[0]!.status === "running")!;
    expect(first).toMatchObject({ current: 1, total: 2 });
    expect(first.actions[1]!.status).toBe("pending");
    const second = ui.find((item) => item.actions[1]!.status === "running")!;
    expect(second).toMatchObject({ current: 2 });
    expect(second.actions[0]!.status).toBe("passed");
    expect(ui.at(-1)!.actions.map((item) => item.status)).toEqual(["passed", "passed"]);
    expect(first.actions[0]!.label).toBe("Click «Edit» in row «Ali»");
  });
});
