"use client";

import { useState } from "react";
import { ChevronRight, Link2, Plus, Trash2 } from "lucide-react";
import { maskSecrets } from "@qa-workbench/shared";
import { Button } from "@/components/ui/button";
import {
  httpSummary,
  sameTarget,
  type InputField,
  type InputLocation,
  type MappingReview,
  type Step,
  type StepRun,
} from "@/components/scenarios/builder-types";
import type { PickerRequest } from "@/components/scenarios/value-picker";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const SECRET_HEADER = /authorization|cookie|token|secret|api[-_]?key|password/i;
const input = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";

type Pair = { key: string; value: string };

const toPairs = (value: unknown): Pair[] =>
  Object.entries(value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}).map(
    ([key, item]) => ({ key, value: String(item ?? "") }),
  );
const fromPairs = (pairs: Pair[]) =>
  Object.fromEntries(pairs.filter((pair) => pair.key.trim()).map((pair) => [pair.key.trim(), pair.value]));

function bodyText(body: unknown) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (typeof body === "object" && Object.keys(body).length === 0) return "";
  return JSON.stringify(body, null, 2);
}

/** Show a header value without exposing credentials. */
function safeHeader(name: string, value: string) {
  if (/^authorization$/i.test(name)) return value.replace(/^(\w+)\s+.+$/, "$1 ••••••");
  return SECRET_HEADER.test(name) ? "••••••" : maskSecrets(value);
}

function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-md border border-border">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className={cn("h-3 w-3 text-muted-foreground transition-transform rtl:-scale-x-100", open && "rotate-90")} />
        {title}
        {count !== undefined ? <span className="text-[10px] font-normal text-muted-foreground">({count})</span> : null}
      </button>
      {open ? <div className="border-t border-border px-3 py-2">{children}</div> : null}
    </section>
  );
}

/** Read view of an HTTP step: every field that can be filled from an earlier response has a button to do so. */
export function RequestView({
  step,
  fields,
  reviews,
  lastRun,
  stepNumber,
  onPick,
}: {
  step: Step;
  fields: InputField[];
  reviews: MappingReview[];
  lastRun?: StepRun;
  stepNumber: (id: string | undefined) => number;
  onPick: (request: PickerRequest) => void;
}) {
  const { t, n } = useI18n();
  const { method, url } = httpSummary(step.config);
  const headers = toPairs(step.config.headers);
  const query = toPairs(step.config.query);
  const body = bodyText(step.config.body);
  const pathFields = fields.filter((field) => field.location === "path");
  const bodyFields = fields.filter((field) => field.location === "body" || field.location === "form");
  const curl = typeof step.config.originalCurl === "string" ? step.config.originalCurl : null;

  const mappedFrom = (location: InputLocation, field: string) => {
    const review = reviews.find((item) => sameTarget(item.binding.target, { location, field }) && item.binding.enabled !== false);
    if (!review) return null;
    const source = review.binding.source;
    const number = review.sourceStep ?? ("stepId" in source ? stepNumber(source.stepId) : 0);
    return number > 0 ? t("builder.request.mappedFrom", { n: n(number) }) : t("builder.mapping.fixedValue");
  };

  const fieldRow = (location: InputLocation, field: string, label: string, value: string) => {
    const mapped = mappedFrom(location, field);
    return (
      <li key={`${location}:${field}`} className="group flex min-w-0 items-center gap-2 py-0.5">
        <span className="w-32 shrink-0 truncate font-mono text-[11px] text-muted-foreground dir-ltr" title={label}>
          {label}
        </span>
        <span className={cn("min-w-0 flex-1 truncate font-mono text-[11px] dir-ltr", mapped && "text-muted-foreground line-through decoration-muted-foreground/40")} title={value}>
          {value}
        </span>
        {mapped ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/40 px-1.5 text-[10px] text-primary">
            <Link2 className="h-3 w-3" />
            {mapped}
          </span>
        ) : null}
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
          aria-label={`${t("builder.request.mapField")}: ${label}`}
          title={t("builder.request.mapField")}
          onClick={() => onPick({ consumerId: step.id, target: { location, field, key: label } })}
        >
          <Link2 className="h-3.5 w-3.5" />
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">{method}</span>
        <span className="min-w-0 break-all font-mono text-xs dir-ltr" dir="ltr">
          {url || "—"}
        </span>
      </div>
      {pathFields.length > 0 ? (
        <ul className="px-1">{pathFields.map((field) => fieldRow("path", field.field, field.key, field.display))}</ul>
      ) : null}

      <Section title={t("builder.request.headers")} count={headers.length}>
        {headers.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("builder.request.noHeaders")}</p>
        ) : (
          <ul>{headers.map((pair) => fieldRow("header", pair.key, pair.key, safeHeader(pair.key, pair.value)))}</ul>
        )}
      </Section>
      <Section title={t("builder.request.query")} count={query.length} defaultOpen={query.length > 0}>
        {query.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("builder.request.noQuery")}</p>
        ) : (
          <ul>{query.map((pair) => fieldRow("query", pair.key, pair.key, maskSecrets(pair.value)))}</ul>
        )}
      </Section>
      <Section title={t("builder.request.body")} defaultOpen={Boolean(body)}>
        {!body ? (
          <p className="text-[11px] text-muted-foreground">{t("builder.request.noBody")}</p>
        ) : (
          <div className="space-y-2">
            {bodyFields.length > 0 ? (
              <ul>{bodyFields.slice(0, 60).map((field) => fieldRow(field.location, field.field, field.field, field.display))}</ul>
            ) : null}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground dir-ltr" dir="ltr">
              {maskSecrets(body)}
            </pre>
          </div>
        )}
      </Section>
      {lastRun?.resolvedInput ? (
        <Section title={t("builder.request.sent")} defaultOpen={false}>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground dir-ltr" dir="ltr">
            {JSON.stringify(lastRun.resolvedInput, null, 2)}
          </pre>
        </Section>
      ) : null}
      {curl ? (
        <Section title={t("builder.request.originalCurl")} defaultOpen={false}>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground dir-ltr" dir="ltr">
            {maskSecrets(curl)}
          </pre>
        </Section>
      ) : null}
    </div>
  );
}

function PairsEditor({
  pairs,
  onChange,
  addLabel,
}: {
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  addLabel: string;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      {pairs.map((pair, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-1">
          <input
            className={`${input} font-mono`}
            dir="ltr"
            aria-label={t("builder.request.key")}
            placeholder={t("builder.request.key")}
            value={pair.key}
            onChange={(event) => onChange(pairs.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)))}
          />
          <input
            className={`${input} font-mono`}
            dir="ltr"
            aria-label={t("builder.request.value")}
            placeholder={t("builder.request.value")}
            value={pair.value}
            onChange={(event) => onChange(pairs.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
          />
          <Button size="icon" variant="ghost" aria-label={t("builder.request.remove")} onClick={() => onChange(pairs.filter((_, i) => i !== index))}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

/** Structured editor for an HTTP step; keeps every other config key (mappings, retries, extract, cURL). */
export function RequestEditor({
  step,
  onSave,
  onCancel,
}: {
  step: Step;
  onSave: (name: string, config: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const summary = httpSummary(step.config);
  const [name, setName] = useState(step.name);
  const [method, setMethod] = useState(summary.method);
  const [url, setUrl] = useState(summary.url);
  const [headers, setHeaders] = useState(toPairs(step.config.headers));
  const [query, setQuery] = useState(toPairs(step.config.query));
  const [body, setBody] = useState(bodyText(step.config.body));
  const [busy, setBusy] = useState(false);

  const trimmed = body.trim();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsedBody: unknown = trimmed ? body : {};
  let jsonError = false;
  if (looksJson) {
    try {
      parsedBody = JSON.parse(trimmed);
    } catch {
      jsonError = true;
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!url.trim() || jsonError) return;
        setBusy(true);
        void onSave(name.trim() || step.name, {
          ...step.config,
          method,
          url: url.trim(),
          headers: fromPairs(headers),
          query: fromPairs(query),
          body: parsedBody,
        }).finally(() => setBusy(false));
      }}
    >
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">{t("builder.request.name")}</span>
        <input className={input} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{t("builder.request.method")}</span>
          <select className={input} value={method} onChange={(event) => setMethod(event.target.value)}>
            {METHODS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{t("builder.request.url")}</span>
          <input
            className={`${input} font-mono`}
            dir="ltr"
            required
            value={url}
            placeholder="https://api.example.com/users/{{userId}}"
            aria-invalid={!url.trim()}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-[11px] text-muted-foreground">{t("builder.request.headers")}</legend>
        <PairsEditor pairs={headers} onChange={setHeaders} addLabel={t("builder.request.addHeader")} />
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-[11px] text-muted-foreground">{t("builder.request.query")}</legend>
        <PairsEditor pairs={query} onChange={setQuery} addLabel={t("builder.request.addParam")} />
      </fieldset>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">{t("builder.request.body")}</span>
        <textarea
          className="min-h-28 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
          dir="ltr"
          value={body}
          placeholder={t("builder.request.bodyHint")}
          aria-invalid={jsonError}
          onChange={(event) => setBody(event.target.value)}
        />
        {jsonError ? <span className="text-[11px] text-destructive">{t("builder.request.invalidJson")}</span> : null}
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("builder.request.cancel")}
        </Button>
        <Button type="submit" disabled={busy || !url.trim() || jsonError}>
          {t("builder.request.save")}
        </Button>
      </div>
    </form>
  );
}
