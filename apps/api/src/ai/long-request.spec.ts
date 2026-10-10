import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { longRequest } from "./long-request";

describe("longRequest", () => {
  let server: Server;
  let url: string;
  let closed: Promise<void>;

  beforeEach(async () => {
    // A model that never answers; resolves `closed` when the client hangs up.
    let markClosed!: () => void;
    closed = new Promise((resolve) => (markClosed = resolve));
    server = createServer((req) => req.on("close", markClosed));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("drops the request in flight when the analysis is cancelled", async () => {
    const cancel = new AbortController();
    const pending = longRequest(url, { method: "POST", body: "{}", timeoutMs: 60_000, signal: cancel.signal });
    setTimeout(() => cancel.abort(), 50);
    await expect(pending).rejects.toThrow("AI analysis was cancelled");
    await closed; // the server sees the disconnect, so Ollama stops generating
  });

  it("reports a timeout as a timeout, not as a cancellation", async () => {
    await expect(longRequest(url, { method: "POST", body: "{}", timeoutMs: 50 })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
