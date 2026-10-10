import { openAppiumSession, type Fetcher } from "./appium-client";

/**
 * An Appium server in memory, for tests: answers the W3C commands the client
 * sends, finds elements by "using|value" keys, and records every request.
 */
export type FakeAppium = {
  fetch: Fetcher;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  /** What each locator finds now ("using|value" → element ids). */
  elements: Record<string, string[]>;
  texts: Record<string, string>;
  source: string;
  /** Sources the next reads return, one each, before `source` again (a screen still changing). */
  sourceQueue: string[];
  /** Called when an element is clicked (e.g. to change the screen). */
  onClick?: (element: string) => void;
  sessions: number;
  open: typeof openAppiumSession;
};

const KEY = "element-6066-11e4-a52e-4f735466cecf";

export function fakeAppium(
  options: {
    source?: string;
    elements?: Record<string, string[]>;
    texts?: Record<string, string>;
    unreachable?: boolean;
    sessionError?: { status: number; message: string };
    size?: { width: number; height: number };
  } = {},
): FakeAppium {
  const fake: FakeAppium = {
    calls: [],
    elements: options.elements ?? {},
    texts: options.texts ?? {},
    source: options.source ?? "<hierarchy/>",
    sourceQueue: [],
    sessions: 0,
    fetch: async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init.body ? (JSON.parse(init.body) as unknown) : undefined;
      fake.calls.push({ method: init.method, path, ...(body !== undefined ? { body } : {}) });
      if (options.unreachable) throw new TypeError("fetch failed");
      const reply = (value: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify({ value }) });
      if (init.method === "POST" && path === "/session") {
        if (options.sessionError) return reply({ error: "session not created", message: options.sessionError.message }, options.sessionError.status);
        fake.sessions += 1;
        return reply({ sessionId: `s${fake.sessions}`, capabilities: {} });
      }
      const match = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
      if (!match) return reply({ error: "unknown command", message: "unknown" }, 404);
      const command = match[2] ?? "";
      if (init.method === "DELETE" && command === "") return reply(null);
      if (command === "/source") return reply(fake.sourceQueue.shift() ?? fake.source);
      if (command === "/screenshot") return reply("iVBORw0KGgo=");
      if (command === "/window/rect") return reply({ x: 0, y: 0, ...(options.size ?? { width: 1080, height: 2220 }) });
      if (command === "/elements") {
        const { using, value } = body as { using: string; value: string };
        return reply((fake.elements[`${using}|${value}`] ?? []).map((id) => ({ [KEY]: id })));
      }
      const element = /^\/element\/([^/]+)\/(\w+)$/.exec(command);
      if (element) {
        const [, id, action] = element;
        if (action === "click") fake.onClick?.(id!);
        if (action === "text") return reply(fake.texts[id!] ?? "");
        if (action === "displayed") return reply(true);
        if (action === "rect") return reply({ x: 10, y: 20, width: 100, height: 40 });
        return reply(null);
      }
      if (command === "/actions" || command === "/back") return reply(null);
      return reply({ error: "unknown command", message: `unknown ${command}` }, 404);
    },
    open: (input, opts) => openAppiumSession(input, { ...opts, fetch: fake.fetch }),
  };
  return fake;
}
