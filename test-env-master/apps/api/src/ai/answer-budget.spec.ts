import { createServer, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { z } from "zod";
import { OllamaProvider } from "./ollama.provider";
import { closePartialJson } from "./structured";

describe("closePartialJson", () => {
  it("keeps every complete item and drops the half-written one", () => {
    const cut = '{"summary":"s","rules":[{"text":"a","evidence":"q"},{"text":"b","evid';
    expect(JSON.parse(closePartialJson(cut)!)).toEqual({ summary: "s", rules: [{ text: "a", evidence: "q" }] });
  });

  it("drops a half-written top-level field and keeps strings with brackets intact", () => {
    const cut = '{"summary":"uses [x] and {y}, then \\"z\\"","apis":[{"method":"GET","path":"/a"}],"states":[{"na';
    expect(JSON.parse(closePartialJson(cut)!)).toEqual({ summary: 'uses [x] and {y}, then "z"', apis: [{ method: "GET", path: "/a" }], states: [] });
  });

  it("returns a complete object unchanged and null when nothing was written", () => {
    expect(closePartialJson('{"a":[1,2]}')).toBe('{"a":[1,2]}');
    expect(closePartialJson("")).toBeNull();
  });
});

describe("Ollama writing time limit", () => {
  let server: Server;
  let url: string;
  const schema = z.object({ summary: z.string(), rules: z.array(z.object({ text: z.string() })).default([]) });

  /** A model that writes one piece every 40 ms and would take seconds to finish. */
  const slowModel = (pieces: string[]) => (res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    let index = 0;
    const timer = setInterval(() => {
      if (index === pieces.length) {
        res.end(`${JSON.stringify({ message: { content: "" }, done: true })}\n`);
        return clearInterval(timer);
      }
      res.write(`${JSON.stringify({ message: { content: pieces[index++] } })}\n`);
    }, 40);
    res.on("close", () => clearInterval(timer));
  };

  const start = async (handler: (res: ServerResponse) => void) => {
    server = createServer((_req, res) => handler(res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const pieces = ['{"summary":"s",', '"rules":[', '{"text":"r1"}', ',{"text":"r2"}', ...Array.from({ length: 200 }, () => ',{"text":"more"}'), "]}"];

  it("stops at the limit and uses the answer written so far", async () => {
    await start(slowModel(pieces));
    const onCut = jest.fn();
    const tokens = jest.fn();
    const provider = new OllamaProvider(url, "m", { timeoutMs: 30_000, answerBudgetMs: 300 });
    const started = Date.now();
    const answer = await provider.generateStructured({ system: "s", prompt: "p", schema, onCut, onTokens: tokens });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(onCut).toHaveBeenCalledTimes(1);
    expect(answer.summary).toBe("s");
    expect(answer.rules.slice(0, 2)).toEqual([{ text: "r1" }, { text: "r2" }]);
    expect(tokens).toHaveBeenCalled();
  });

  it("returns the whole answer when the model finishes within the limit", async () => {
    await start(slowModel(['{"summary":"s",', '"rules":[{"text":"r1"}]}']));
    const onCut = jest.fn();
    const answer = await new OllamaProvider(url, "m", { timeoutMs: 30_000, answerBudgetMs: 5_000 }).generateStructured({ system: "s", prompt: "p", schema, onCut });
    expect(answer).toEqual({ summary: "s", rules: [{ text: "r1" }] });
    expect(onCut).not.toHaveBeenCalled();
  });

  it("still treats a user cancel as a cancel, not as a partial answer", async () => {
    await start(slowModel(pieces));
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 200);
    const provider = new OllamaProvider(url, "m", { timeoutMs: 30_000, answerBudgetMs: 5_000 });
    await expect(provider.generateStructured({ system: "s", prompt: "p", schema, signal: cancel.signal })).rejects.toThrow("cancelled");
  });
});
