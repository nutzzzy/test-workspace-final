import { assertResolvedHostAllowed, normalizeHost } from "../../common/network-policy";
import { assertResolved, bindRequest, captureResponse, lookup, type ConsumedVar } from "../auto-bind";
import { isFormBody } from "../flow/request-inputs";
import { interpolateJsonText, isJsonText } from "../flow/response-mapping";
import type { ExecutionContext, StepExecutionResult, StepExecutor } from "../types";

async function assertSafeUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsafe URL protocol: ${url.protocol}`);
  }
  const host = normalizeHost(url.hostname);
  try {
    await assertResolvedHostAllowed(host);
  } catch {
    throw new Error(`SSRF protection blocked host: ${host}`);
  }
  return url;
}

export type ResolvedHttpRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

/**
 * Optional `expectedStatus` (number or list). Without it the executor itself
 * reports any response as PASSED; in a scenario the orchestrator then requires
 * 2xx/3xx (or a status assertion) plus every attached assertion.
 */
export function expectedStatuses(config: Record<string, unknown>): number[] | null {
  const raw = config.expectedStatus;
  const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw])
    .map(Number)
    .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599);
  return list.length ? list : null;
}

function dedupeConsumed(items: ConsumedVar[]): ConsumedVar[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.variable}|${item.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** name → value of every Set-Cookie of the response. */
function readSetCookies(headers: Headers): Record<string, string> {
  const list =
    typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [];
  const out: Record<string, string> = {};
  for (const line of list) {
    const pair = line.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function hasHeader(headers: Record<string, string> | undefined, name: string) {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name);
}

export class HttpRequestExecutor implements StepExecutor {
  readonly type = "HTTP_REQUEST";

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<StepExecutionResult> {
    if (context.isCancelled()) {
      return { status: "CANCELLED", error: "Cancelled before HTTP request" };
    }
    const { request, consumed } = this.prepare(config, context);
    const result = await this.send(request, context, expectedStatuses(config));
    return consumed.length ? { ...result, consumedVars: consumed } : result;
  }

  /** Resolve variables and auto-binding into the exact request to send. */
  prepare(config: Record<string, unknown>, context: ExecutionContext) {
    const requestConfig = { ...config };
    delete requestConfig.originalCurl;
    delete requestConfig.recovery;
    delete requestConfig.expectedStatus;
    delete requestConfig.bindings;
    delete requestConfig.continueOnFailure;
    delete requestConfig.extract;
    // cURL imports saved before placeholders were preserved hold {{x}} percent-encoded.
    if (typeof requestConfig.url === "string") {
      requestConfig.url = requestConfig.url.replace(/%7B%7B([A-Za-z0-9_.-]+)%7D%7D/gi, "{{$1}}");
    }
    const consumed: ConsumedVar[] = [];
    const headers = requestConfig.headers as Record<string, string> | undefined;
    const jsonText = isJsonText(requestConfig.body, headers) && !isFormBody({ body: requestConfig.body, headers })
      ? this.bindJsonText(requestConfig.body as string, context, consumed)
      : undefined;
    if (jsonText !== undefined) delete requestConfig.body;
    const request = assertResolved(bindRequest(requestConfig, context, consumed)) as ResolvedHttpRequest;
    if (jsonText !== undefined) request.body = jsonText;
    return { request, consumed: dedupeConsumed(consumed) };
  }

  /** A raw JSON text body: substitute values so the text stays valid JSON. */
  private bindJsonText(body: string, context: ExecutionContext, consumed: ConsumedVar[]) {
    const result = interpolateJsonText(body, (name) => {
      if (context.get(name) !== undefined) return { value: context.typedValue(name) };
      const loose = lookup(name, context);
      return loose === undefined ? undefined : { value: loose };
    });
    if (result.missing.length > 0) throw new Error(`Unresolved variable: {{${result.missing[0]}}}`);
    for (const variable of result.used) {
      const source = context.sourceOf(variable);
      consumed.push({ variable, location: "body", ...(source ? { source } : {}) });
    }
    if (result.used.length > 0) {
      try {
        JSON.parse(result.text);
      } catch {
        throw new Error("JSON body is not valid JSON after variable substitution");
      }
    }
    return result.text;
  }

  /** Send an already resolved request (also used verbatim by recovery retries). */
  async send(
    resolved: ResolvedHttpRequest,
    context: ExecutionContext,
    expected: number[] | null = null,
  ): Promise<StepExecutionResult> {
    if (context.isCancelled()) {
      return { status: "CANCELLED", error: "Cancelled before HTTP request" };
    }
    // Assertions after this step must never read the previous step's response.
    context.lastHttpResponse = null;
    const method = (resolved.method ?? "GET").toUpperCase();
    let url: URL;
    try {
      url = await assertSafeUrl(resolved.url);
    } catch (error) {
      return {
        status: "FAILED",
        resolvedInput: context.redact({ method, url: resolved.url }),
        error: error instanceof Error ? error.message : "Invalid URL",
      };
    }
    if (resolved.query) {
      for (const [k, v] of Object.entries(resolved.query)) {
        url.searchParams.set(k, v);
      }
    }

    const timeoutMs = Math.min(Math.max(resolved.timeoutMs ?? 15000, 1000), 60000);
    const controller = new AbortController();
    // A timeout is a failure of the endpoint, not a user cancellation; the
    // flag keeps the two apart when the shared AbortController fires.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const unsubscribe = context.onAbort(() => controller.abort());

    const sendsBody = resolved.body !== undefined && method !== "GET" && method !== "HEAD";
    const jsonBody = sendsBody && typeof resolved.body !== "string";
    const formBody = sendsBody && !jsonBody && isFormBody({ body: resolved.body, headers: resolved.headers });
    // An object body is JSON and a=b&c=d is a form; without this fetch labels both text/plain.
    const headers =
      (jsonBody || formBody) && !hasHeader(resolved.headers, "content-type")
        ? {
            ...(resolved.headers ?? {}),
            "Content-Type": jsonBody ? "application/json" : "application/x-www-form-urlencoded",
          }
        : resolved.headers;
    const requestStarted = Date.now();

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: !sendsBody
          ? undefined
          : typeof resolved.body === "string"
            ? resolved.body
            : JSON.stringify(resolved.body),
        signal: controller.signal,
        redirect: "manual",
      });

      if (context.isCancelled()) {
        return { status: "CANCELLED", error: "Cancelled during HTTP request" };
      }

      // Redirects are not followed (the target could be any host), but a 3xx is a
      // normal answer: its Location header and cookies are available to later steps.

      const rawBody = await response.text();
      if (rawBody.length > 1_000_000) {
        throw new Error("Response too large (>1MB)");
      }

      let body: unknown = rawBody;
      try {
        body = JSON.parse(rawBody);
      } catch {
        // keep text
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const cookies = readSetCookies(response.headers);
      for (const value of Object.values(cookies)) context.markSecret(value);
      const durationMs = Date.now() - requestStarted;

      context.lastHttpResponse = {
        status: response.status,
        headers: responseHeaders,
        body,
        rawBody,
        cookies,
        durationMs,
      };
      const learned = captureResponse(body, context, url.origin);
      context.exchanges.push({ url: url.toString(), headers: { ...(headers ?? {}) }, status: response.status, setCookies: cookies });
      if (context.exchanges.length > 200) context.exchanges.shift();

      const statusMismatch = expected && !expected.includes(response.status);
      return {
        status: statusMismatch ? "FAILED" : "PASSED",
        ...(statusMismatch
          ? { error: `Expected HTTP ${expected.join(" or ")}, got ${response.status}` }
          : {}),
        extractedVars: Object.keys(learned).length
          ? (context.redact(learned) as Record<string, string>)
          : undefined,
        resolvedInput: context.redact({
          method,
          url: url.toString(),
          headers,
          query: resolved.query,
          body: resolved.body,
        }),
        output: context.redact({
          status: response.status,
          headers: responseHeaders,
          body,
          durationMs,
          ...(Object.keys(cookies).length ? { cookies: Object.keys(cookies) } : {}),
        }),
      };
    } catch (error) {
      const input = context.redact({ method, url: resolved.url, headers });
      if (timedOut && !context.isCancelled()) {
        return {
          status: "FAILED",
          resolvedInput: input,
          error: `Request timed out after ${timeoutMs} ms`,
        };
      }
      if (context.isCancelled() || (error instanceof Error && error.name === "AbortError")) {
        return {
          status: "CANCELLED",
          resolvedInput: input,
          error: "Cancelled during HTTP request",
        };
      }
      return {
        status: "FAILED",
        resolvedInput: input,
        error: error instanceof Error ? error.message : "HTTP request failed",
      };
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }
}
