import type { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { LearningService } from "../analysis/studio/learning";
import type { PrismaService } from "../prisma/prisma.service";
import { AIService, isExternal } from "./ai.service";

// Model calls go through long-request (node http); here they are routed to the mocked fetch.
jest.mock("./long-request", () => ({
  longRequest: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) =>
    fetch(url, { method: init.method, headers: init.headers, body: init.body }),
}));

type Row = Record<string, unknown> & { id: string; name: string; kind: string; baseUrl: string; model: string };

function service(connections: Row[], routing: Record<string, string[]> = {}) {
  const rows = connections.map((row, index) => ({
    apiKeyEnc: "",
    allowExternal: false,
    enabled: true,
    temperature: 0.2,
    timeoutMs: 5000,
    contextTokens: 16384,
    reasoning: false,
    priority: index,
    createdAt: new Date(index),
    ...row,
  }));
  const prisma = {
    aiConnection: {
      count: async () => rows.length,
      findMany: async () => [...rows].sort((a, b) => (a.priority as number) - (b.priority as number)),
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
    },
    systemSetting: {
      findUnique: async () => ({ key: "ai.routing", value: JSON.stringify(routing) }),
      findMany: async () => [],
    },
  } as unknown as PrismaService;
  const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
  return new AIService(config, prisma);
}

/** fetch mock: each connection (by port) answers with its script. */
function serve(scripts: Record<string, Array<() => Response>>) {
  const seen: string[] = [];
  jest.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    seen.push(url.port);
    const next = scripts[url.port]?.shift();
    if (!next) throw new TypeError("fetch failed");
    return next();
  });
  return seen;
}
const ok = (content: unknown) => () => new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }));
const schema = z.object({ answer: z.string() });

afterEach(() => jest.restoreAllMocks());

describe("AI routing", () => {
  const local = (id: string, port: string) => ({ id, name: id, kind: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "m" });

  it("follows the stage's routing, then falls back to the next connection when one fails", async () => {
    const ai = service([local("a", "1001"), local("b", "1002")], { testCases: ["b", "a"] });
    const seen = serve({ "1002": [() => new Response("down", { status: 500, headers: { "retry-after": "0.01" } }), () => new Response("down", { status: 500, headers: { "retry-after": "0.01" } }), () => new Response("down", { status: 500, headers: { "retry-after": "0.01" } })], "1001": [ok({ answer: "from a" })] });
    const result = await ai.call("testCases", { system: "s", prompt: "p", schema }, { attemptsPerConnection: 3 });
    expect(result).toMatchObject({ data: { answer: "from a" }, origin: { connectionId: "a" } });
    expect(seen[0]).toBe("1002");
  });

  it("skips an unreachable connection for a while instead of retrying it on every call", async () => {
    const ai = service([local("a", "1001"), local("b", "1002")]);
    const seen = serve({ "1002": [ok({ answer: "b1" }), ok({ answer: "b2" })] });
    await ai.call("analysis", { system: "s", prompt: "p", schema });
    await ai.call("analysis", { system: "s", prompt: "p", schema });
    expect(seen.filter((port) => port === "1001")).toHaveLength(1);
  });

  it("lets a different model than the test-case writer do the review", async () => {
    const ai = service([local("writer", "1001"), local("reviewer", "1002")], { testCases: ["writer"] });
    const chain = await ai.chainFor("review");
    expect(chain[0]!.id).toBe("reviewer");
  });

  it("never sends text to an external service without consent and a key", async () => {
    const ai = service([{ id: "x", name: "hosted", kind: "openai", baseUrl: "https://api.example.com/v1", model: "m" }]);
    const fetch = jest.spyOn(global, "fetch");
    expect(await ai.analysisStatus()).toMatchObject({ ready: false, reason: "external_not_allowed" });
    await expect(ai.call("analysis", { system: "s", prompt: "p", schema })).rejects.toThrow(/not available/);
    expect(fetch).not.toHaveBeenCalled();
    expect(isExternal("http://192.168.1.20:11434")).toBe(false);
  });

  it("asks again with the validation error when an answer does not fit the schema", async () => {
    const ai = service([local("a", "1001")]);
    serve({ "1001": [ok({ wrong: true }), ok({ answer: "fixed" })] });
    const fetch = global.fetch as jest.Mock;
    await expect(ai.call("analysis", { system: "s", prompt: "p", schema })).resolves.toMatchObject({ data: { answer: "fixed" } });
    const second = JSON.parse(String(fetch.mock.calls[1]![1].body)) as { messages: Array<{ content: string }>; format: unknown; options: { num_ctx: number } };
    expect(second.messages[1]!.content).toContain("previous answer was rejected");
    // Ollama gets the schema for constrained output and a real context window.
    expect(second.format).toMatchObject({ type: "object" });
    expect(second.options.num_ctx).toBe(16384);
  });
});

describe("learning guidance", () => {
  it("gives each stage its guidelines and the team's recent corrections of that kind", async () => {
    const prisma = {
      aiGuideline: { findMany: async () => [{ scope: "testCases", text: "Start titles with the endpoint." }, { scope: "all", text: "Write in Persian." }] },
      aiFeedback: {
        findMany: async () => [
          { artifact: "testCase", action: "edit", before: { title: "بررسی معیار AC-01" }, after: { title: "POST /create: رد بدون Description" } },
          { artifact: "edgeCase", action: "delete", before: { title: "generic" } },
        ],
      },
    } as unknown as PrismaService;
    const guidance = await new LearningService(prisma, {} as AIService).guidance();
    const cases = guidance("testCases");
    expect(cases).toContain("Start titles with the endpoint.");
    expect(cases).toContain("Write in Persian.");
    expect(cases).toContain("POST /create: رد بدون Description");
    expect(cases).not.toContain("generic");
    expect(guidance("edgeCases")).toContain("REMOVED BY THE TEAM");
    expect(guidance("risks")).not.toContain("Start titles");
  });
});
