import { Badge } from "@/components/ui/badge";

type Fact = { key: string; value: string };

const WRAP_KEYS = /^(result|data|payload)$/i;
const SKIP_KEYS =
  /sentry|baggage|trace|cookie|authorization|user-agent|sec-|ratelimit|cache|cf-|report-to|alt-svc|server-timing|etag|nel|x-envoy|x-powered|x-request-id|origin|referer|accept|content-type|content-length/i;

export function StepRunFacts({
  name,
  typeLabel,
  status,
  statusLabel,
  durationMs,
  error,
  resolvedInput,
  output,
  extractedVars,
  formatNumber,
  formatDate,
  learnedLabel,
  rawLabel,
  children,
}: {
  name: string;
  typeLabel: string;
  status: string;
  statusLabel: string;
  durationMs?: number;
  error?: string | null;
  resolvedInput?: unknown;
  output?: unknown;
  extractedVars?: unknown;
  formatNumber: (value: number) => string;
  formatDate: (value: string | Date) => string;
  learnedLabel: string;
  rawLabel: string;
  /** Extra per-step detail (variables used/produced, recovery trace). */
  children?: React.ReactNode;
}) {
  const input = asRecord(resolvedInput);
  const response = asRecord(output);
  const method = text(input?.method).toUpperCase();
  const url = text(input?.url);
  const query = scalarPairs(input?.query);
  const statusCode = typeof response?.status === "number" ? response.status : null;
  const fields = pickFields(response?.body ?? output, Boolean(method || statusCode != null));
  const learned = pickLearned(extractedVars);
  const showRaw = Boolean(resolvedInput || output || extractedVars);

  return (
    <div className="space-y-2 rounded border border-border/70 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge className={runTone(status)}>{statusLabel}</Badge>
          <span className="truncate text-sm">{name}</span>
          <span className="text-[10px] text-muted-foreground">{typeLabel}</span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatNumber(durationMs ?? 0)}ms
        </span>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {children}

      {method || statusCode != null || url ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {method ? <Badge>{method}</Badge> : null}
          {statusCode != null ? (
            <Badge className={codeTone(statusCode)}>{formatNumber(statusCode)}</Badge>
          ) : null}
          {url ? (
            <span className="dir-ltr min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {displayUrl(url, query.length > 0)}
            </span>
          ) : null}
        </div>
      ) : null}

      {query.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {query.map((item) => (
            <span
              key={item.key}
              className="dir-ltr rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {item.key}={present(item.value, formatNumber, formatDate)}
            </span>
          ))}
        </div>
      ) : null}

      {fields.length > 0 ? (
        <dl className="grid gap-1 sm:grid-cols-2">
          {fields.map((item) => (
            <div
              key={item.key}
              className="flex min-w-0 items-baseline justify-between gap-3 rounded border border-border/60 px-2 py-1"
            >
              <dt className="dir-ltr shrink-0 font-mono text-[10px] text-muted-foreground">
                {item.key}
              </dt>
              <dd className="dir-ltr min-w-0 truncate text-end text-xs">
                {present(item.value, formatNumber, formatDate)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {learned.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {learnedLabel}
          </div>
          <div className="flex flex-wrap gap-1">
            {learned.map((item) => (
              <span
                key={item.key}
                className="dir-ltr rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]"
              >
                {item.key}{" "}
                <span className="text-foreground">
                  {present(item.value, formatNumber, formatDate)}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {showRaw ? (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer">{rawLabel}</summary>
          <pre className="mt-1 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2 font-mono dir-ltr">
            {JSON.stringify(
              {
                request: resolvedInput ?? null,
                response: output ?? null,
                learned: extractedVars ?? null,
              },
              null,
              2,
            )}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function VariableFacts({
  title,
  value,
  formatNumber,
  formatDate,
}: {
  title: string;
  value: unknown;
  formatNumber: (value: number) => string;
  formatDate: (value: string | Date) => string;
}) {
  const items = pickLearned(value);
  if (items.length === 0) return null;
  return (
    <div className="space-y-1 rounded border border-border/70 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item.key}
            className="dir-ltr rounded border border-border px-1.5 py-0.5 font-mono text-[10px]"
          >
            {item.key}{" "}
            <span className="text-foreground">
              {present(item.value, formatNumber, formatDate)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function pickFields(body: unknown, http: boolean): Fact[] {
  const record = asRecord(body);
  if (!record) {
    if (typeof body === "string" && body.trim()) return [{ key: "body", value: body }];
    return [];
  }
  const preferred = ["message", "success", "ok", "error", "code"];
  const wrapped = Object.entries(record).find(
    ([key, value]) => WRAP_KEYS.test(key) && asRecord(value),
  );
  const source = wrapped ? { ...asRecord(wrapped[1]), ...record } : record;
  const facts: Fact[] = [];
  const used = new Set<string>();
  const push = (key: string, value: unknown) => {
    if (used.has(key) || SKIP_KEYS.test(key) || WRAP_KEYS.test(key)) return;
    if (http && key.toLowerCase() === "status") return;
    const rendered = scalarText(value);
    if (!rendered) return;
    used.add(key);
    facts.push({ key, value: rendered });
  };
  for (const key of preferred) {
    if (key in source) push(key, source[key]);
  }
  for (const [key, value] of Object.entries(source)) push(key, value);
  return facts.slice(0, 8);
}

function pickLearned(value: unknown): Fact[] {
  const record = asRecord(value);
  if (!record) return [];
  const leaves = new Set(
    Object.keys(record)
      .filter((key) => !key.includes("."))
      .map((key) => key.toLowerCase()),
  );
  const facts: Fact[] = [];
  for (const [key, item] of Object.entries(record)) {
    if (key.includes(".") && leaves.has(key.slice(key.lastIndexOf(".") + 1).toLowerCase())) {
      continue;
    }
    if (SKIP_KEYS.test(key)) continue;
    const rendered = scalarText(item);
    if (!rendered || rendered.length > 80) continue;
    facts.push({ key, value: rendered });
    if (facts.length >= 8) break;
  }
  return facts;
}

function scalarPairs(value: unknown): Fact[] {
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .map(([key, item]) => ({ key, value: scalarText(item) }))
    .filter((item) => item.value)
    .slice(0, 6);
}

function present(
  value: string,
  formatNumber: (value: number) => string,
  formatDate: (value: string | Date) => string,
) {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return formatNumber(numeric);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return formatDate(date);
  }
  return value;
}

function scalarText(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 160) return "";
    return trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function displayUrl(url: string, stripQuery: boolean) {
  if (!stripQuery) return url;
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function runTone(status: string) {
  if (status === "PASSED") return "border-success/40 bg-success/10 text-success";
  if (status === "FAILED") return "border-destructive/40 bg-destructive/10 text-destructive";
  if (status === "CANCELLED") return "border-warning/40 bg-warning/10 text-warning";
  if (status === "RUNNING") return "border-primary/40 bg-primary/10 text-primary";
  return "";
}

function codeTone(code: number) {
  if (code >= 200 && code < 300) return "border-success/40 bg-success/10 text-success";
  if (code >= 400) return "border-destructive/40 bg-destructive/10 text-destructive";
  return "border-warning/40 bg-warning/10 text-warning";
}
