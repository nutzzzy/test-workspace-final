import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";

/**
 * HTTP for model calls. The global fetch gives up when response headers take
 * more than 5 minutes, and a non-streaming model call sends its headers only
 * when the whole answer is generated — a slow local model easily takes longer.
 * Here the only limit is the connection's own timeout.
 */
export type LongResponse = { status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> };

export function longRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal; onData?: (chunk: string) => void },
): Promise<LongResponse> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: init.method ?? "GET",
        headers: { ...(init.headers ?? {}), ...(init.body !== undefined ? { "Content-Length": String(Buffer.byteLength(init.body)) } : {}) },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs)]) : AbortSignal.timeout(init.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          // Only a successful answer is streamed; an error body is read whole.
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) init.onData?.(chunk.toString("utf8"));
        });
        res.on("error", reject);
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: { get: (name) => {
              const value = res.headers[name.toLowerCase()];
              return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
            } },
            text: async () => body,
          });
        });
      },
    );
    req.on("error", (error: Error) => {
      // Same shape as fetch's network failure, so callers handle both alike.
      if (init.signal?.aborted) reject(Object.assign(new Error("AI analysis was cancelled"), { name: "AbortError" }));
      else if (error.name === "AbortError") reject(Object.assign(new Error("The model did not answer in time"), { name: "TimeoutError" }));
      else reject(new TypeError(`fetch failed: ${error.message}`));
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
