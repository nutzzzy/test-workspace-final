"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { formatJsonPath, type JsonPathSegment } from "@qa-workbench/shared";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A value the user picked: where it is (registry path) and what it looks like. */
export type ResponsePick = {
  /** response.body.data.user.id · response.headers.x-request-id */
  path: string;
  /** $.data.user.id, for display */
  label: string;
  type: ValueType;
  value: unknown;
  secret: boolean;
};

export type ValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

const SECRET_KEY =
  /^(?:.*(?:password|passwd|secret|token|apikey|authorization|cookie|credential|privatekey|sessionid)|jwt|pwd|pin|otp)$/;
const isSecretKey = (key: string) => SECRET_KEY.test(key.replace(/[-_\s]/g, "").toLowerCase());
/** Values the API already redacted. */
const isMaskedText = (value: unknown) => typeof value === "string" && (value === "***" || /^Bearer \*\*\*$/.test(value));

const MAX_DEPTH = 12;
const PAGE = 50;
const MAX_SEARCH_RESULTS = 200;
const MAX_RAW = 200_000;

export function typeOf(value: unknown): ValueType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/** Only scalars can fill a request field. */
export const isMappable = (type: ValueType) => type === "string" || type === "number" || type === "boolean";

function bodyPick(segments: JsonPathSegment[], value: unknown, secret: boolean): ResponsePick {
  return {
    path: ["response.body", ...segments.map(String)].join("."),
    label: formatJsonPath(segments),
    type: typeOf(value),
    value,
    secret,
  };
}

type Leaf = { segments: JsonPathSegment[]; key: string; value: unknown; secret: boolean };

function collectLeaves(value: unknown): Leaf[] {
  const out: Leaf[] = [];
  const visit = (item: unknown, segments: JsonPathSegment[], secret: boolean, depth: number) => {
    if (out.length >= 5000 || depth > MAX_DEPTH) return;
    if (item && typeof item === "object") {
      const entries = Array.isArray(item) ? item.map((child, index) => [index, child] as const) : Object.entries(item);
      for (const [key, child] of entries) {
        visit(child, [...segments, key], secret || (typeof key === "string" && isSecretKey(key)), depth + 1);
      }
      return;
    }
    const key = String(segments[segments.length - 1] ?? "");
    out.push({ segments, key, value: item, secret: secret || isMaskedText(item) });
  };
  visit(value, [], false, 0);
  return out;
}

function display(value: unknown, secret: boolean, maskedLabel: string) {
  if (secret) return `•••••• (${maskedLabel})`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value.length > 160 ? `"${value.slice(0, 157)}…"` : `"${value}"`;
  return String(value);
}

/**
 * Searchable, collapsible view of a response. Sensitive values are masked
 * (by key name, and values the API already redacted); a scalar can be
 * selected or acted on through `actions`.
 */
export function ResponseExplorer({
  body,
  headers,
  onSelect,
  selectedPath,
  actions,
  compact,
}: {
  body: unknown;
  headers?: Record<string, string>;
  onSelect?: (pick: ResponsePick) => void;
  selectedPath?: string | null;
  actions?: (pick: ResponsePick) => React.ReactNode;
  compact?: boolean;
}) {
  const { t, n } = useI18n();
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState(false);
  const leaves = useMemo(() => collectLeaves(body), [body]);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    return leaves.filter((leaf) => {
      const path = formatJsonPath(leaf.segments).toLowerCase();
      return path.includes(needle) || (!leaf.secret && String(leaf.value).toLowerCase().includes(needle));
    });
  }, [leaves, needle]);
  const headerRows = Object.entries(headers ?? {}).filter(([name]) =>
    !needle || name.toLowerCase().includes(needle) || (!isSecretKey(name) && String(headers?.[name]).toLowerCase().includes(needle)),
  );
  const maskedLabel = t("builder.response.masked");

  const row = (pick: ResponsePick, keyLabel: React.ReactNode, depth = 0) => {
    const selectable = Boolean(onSelect) && isMappable(pick.type);
    const selected = selectedPath === pick.path;
    return (
      <div
        key={pick.path}
        className={cn(
          "group flex min-w-0 items-center gap-2 rounded px-1 py-0.5 font-mono text-[11px]",
          selected ? "bg-primary/15" : "hover:bg-accent/60",
        )}
        style={{ paddingInlineStart: `${depth * 12 + 18}px` }}
      >
        {selectable ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-baseline gap-2 text-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-pressed={selected}
            onClick={() => onSelect?.(pick)}
          >
            <span className="shrink-0 text-muted-foreground">{keyLabel}</span>
            <span className={cn("min-w-0 break-all", pick.secret ? "text-warning" : valueTone(pick.type))}>
              {display(pick.value, pick.secret, maskedLabel)}
            </span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 text-muted-foreground">{keyLabel}</span>
            <span className={cn("min-w-0 break-all", pick.secret ? "text-warning" : valueTone(pick.type))}>
              {display(pick.value, pick.secret, maskedLabel)}
            </span>
          </div>
        )}
        {actions && isMappable(pick.type) ? (
          <span className="flex shrink-0 gap-1 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
            {actions(pick)}
          </span>
        ) : null}
      </div>
    );
  };

  const empty = body === undefined || body === null || body === "" || (typeof body === "object" && Object.keys(body).length === 0);

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("builder.response.search")}</span>
          <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-8 w-full rounded-md border border-border bg-background ps-7 pe-2 text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("builder.response.search")}
          />
        </label>
        {typeof body === "object" && body !== null ? (
          <div className="flex shrink-0 rounded-md border border-border p-0.5 text-[11px]" role="group">
            <button
              type="button"
              aria-pressed={!raw}
              className={cn("rounded px-2 py-0.5", !raw ? "bg-accent text-foreground" : "text-muted-foreground")}
              onClick={() => setRaw(false)}
            >
              {t("builder.response.tree")}
            </button>
            <button
              type="button"
              aria-pressed={raw}
              className={cn("rounded px-2 py-0.5", raw ? "bg-accent text-foreground" : "text-muted-foreground")}
              onClick={() => setRaw(true)}
            >
              {t("builder.response.raw")}
            </button>
          </div>
        ) : null}
      </div>

      <div className={cn("overflow-auto rounded-md border border-border py-1 dir-ltr", compact ? "max-h-64" : "max-h-[28rem]")} dir="ltr">
        {raw ? (
          <pre className="whitespace-pre-wrap break-all px-2 font-mono text-[11px] text-muted-foreground">
            {JSON.stringify(body, null, 2).slice(0, MAX_RAW)}
          </pre>
        ) : needle ? (
          <>
            <p className="px-2 pb-1 text-[10px] text-muted-foreground">
              {matches.length > MAX_SEARCH_RESULTS
                ? t("builder.response.truncated", { count: n(MAX_SEARCH_RESULTS) })
                : t("builder.response.matches", { count: n(matches.length + headerRows.length) })}
            </p>
            {matches.slice(0, MAX_SEARCH_RESULTS).map((leaf) =>
              row(bodyPick(leaf.segments, leaf.value, leaf.secret), formatJsonPath(leaf.segments)),
            )}
            {matches.length === 0 && headerRows.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">{t("builder.response.noMatch")}</p>
            ) : null}
          </>
        ) : empty ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t("builder.response.empty")}</p>
        ) : typeof body === "object" ? (
          <Node value={body} segments={[]} depth={0} secret={false} row={row} />
        ) : (
          row(bodyPick([], body, isMaskedText(body)), "$")
        )}
        {headerRows.length > 0 && !raw ? (
          <div className="mt-1 border-t border-border pt-1">
            <div className="px-2 text-[10px] uppercase tracking-wide text-muted-foreground">{t("builder.response.headers")}</div>
            {headerRows.map(([name, value]) =>
              row(
                {
                  path: `response.headers.${name.toLowerCase()}`,
                  label: name,
                  type: "string",
                  value,
                  secret: isSecretKey(name) || isMaskedText(value),
                },
                name,
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function valueTone(type: ValueType) {
  if (type === "number") return "text-primary";
  if (type === "boolean") return "text-warning";
  if (type === "null") return "text-muted-foreground";
  return "text-foreground";
}

function Node({
  value,
  segments,
  depth,
  secret,
  row,
}: {
  value: unknown;
  segments: JsonPathSegment[];
  depth: number;
  secret: boolean;
  row: (pick: ResponsePick, keyLabel: React.ReactNode, depth?: number) => React.ReactNode;
}) {
  const { t, n } = useI18n();
  const [limit, setLimit] = useState(PAGE);
  const entries = Array.isArray(value)
    ? value.map((child, index) => [index, child] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <>
      {entries.slice(0, limit).map(([key, child]) => {
        const path = [...segments, key];
        const childSecret = secret || (typeof key === "string" && isSecretKey(key));
        const label = typeof key === "number" ? `[${key}]` : key;
        if (child && typeof child === "object" && depth < MAX_DEPTH) {
          return <Branch key={String(key)} value={child} segments={path} depth={depth} secret={childSecret} label={label} row={row} />;
        }
        return row(bodyPick(path, child, childSecret || isMaskedText(child)), label, depth);
      })}
      {entries.length > limit ? (
        <button
          type="button"
          className="px-2 py-0.5 text-[11px] text-primary hover:underline"
          style={{ paddingInlineStart: `${depth * 12 + 18}px` }}
          onClick={() => setLimit((current) => current + PAGE)}
        >
          {t("builder.response.showMore", { count: n(Math.min(PAGE, entries.length - limit)) })}
        </button>
      ) : null}
    </>
  );
}

function Branch({
  value,
  segments,
  depth,
  secret,
  label,
  row,
}: {
  value: object;
  segments: JsonPathSegment[];
  depth: number;
  secret: boolean;
  label: string;
  row: (pick: ResponsePick, keyLabel: React.ReactNode, depth?: number) => React.ReactNode;
}) {
  const { t, n } = useI18n();
  const [open, setOpen] = useState(depth < 2);
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-start font-mono text-[11px] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={{ paddingInlineStart: `${depth * 12 + 4}px` }}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100", open && "rotate-90")} />
        <span className="text-foreground">{label}</span>
        <span className="text-[10px] text-muted-foreground">
          {Array.isArray(value) ? t("builder.response.items", { count: n(size) }) : t("builder.response.keys", { count: n(size) })}
        </span>
      </button>
      {open ? <Node value={value} segments={segments} depth={depth + 1} secret={secret} row={row} /> : null}
    </div>
  );
}
