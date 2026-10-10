"use client";

import { useState } from "react";
import { ListFilter, Sparkles } from "lucide-react";
import { BidiText } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ListPick, PickCondition, ResponseSource, StepBinding } from "@/components/scenarios/builder-types";

/** What the API tells about the list a mapping reads (POST /scenarios/:id/list-pick/help). */
export type ListPickHelp = {
  list: string;
  item: string;
  index: number;
  count: number;
  preview: Array<{ index: number; value: string }>;
  anchors: Array<{
    condition: PickCondition;
    matches: number;
    preview: { itemValue: string; otherValue: string; otherStep: string; otherPath: string };
  }>;
};

/** response.body.orders.0.id → list / index / item; null for a value that is not inside a list. */
export function splitListPath(path: string) {
  const parts = path.split(".");
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    if (/^\d+$/.test(parts[at]!)) return { list: parts.slice(0, at).join("."), index: Number(parts[at]), item: parts.slice(at + 1).join(".") };
  }
  return null;
}

type Mode = "fixed" | "first" | "last" | "where";

const input = "h-7 min-w-0 rounded-md border border-border bg-background px-2 text-xs";

/**
 * Which item of a list a mapping reads. A fixed position breaks as soon as
 * the list changes order or grows; "the item where code is in the URL the UI
 * step ended on" stays right every run.
 */
export function ListPickEditor({
  binding,
  load,
  onSave,
}: {
  binding: StepBinding & { source: ResponseSource };
  load: () => Promise<ListPickHelp>;
  onSave: (binding: StepBinding) => Promise<void>;
}) {
  const { t, n } = useI18n();
  const split = splitListPath(binding.source.path);
  const current = binding.source.pick;
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState<ListPickHelp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(current?.where?.length ? "where" : current ? (current.position === "last" ? "last" : "first") : "fixed");
  const [condition, setCondition] = useState<PickCondition | null>(current?.where?.[0] ?? null);
  const [busy, setBusy] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || help) return;
    load()
      .then((value) => {
        setHelp(value);
        // The condition that singles out exactly this item is the sensible default.
        if (!condition && value.anchors[0]?.matches === 1) setCondition(value.anchors[0].condition);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Request failed"));
  };

  if (!split) return null;
  const listName = split.list.replace(/^response\.body\.?/, "") || "list";

  const summary = current?.where?.length
    ? t("listPick.summaryWhere", { field: current.where[0]!.field, op: t(`listPick.ops.${current.where[0]!.op}`), value: describeValue(current.where[0]!) })
    : current?.position === "last"
      ? t("listPick.summaryLast")
      : current
        ? t("listPick.summaryFirst")
        : t("listPick.summaryFixed", { index: n(split.index + 1) });

  const save = async () => {
    const pick: ListPick | undefined =
      mode === "fixed"
        ? undefined
        : mode === "where" && condition
          ? { list: split.list, item: split.item, where: [condition] }
          : { list: split.list, item: split.item, ...(mode === "last" ? { position: "last" as const } : {}) };
    const source: ResponseSource = { ...binding.source };
    delete source.pick;
    setBusy(true);
    try {
      await onSave({ ...binding, source: pick ? { ...source, pick } : source });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-dashed border-border px-2 py-1.5">
      <button type="button" className="flex w-full items-center gap-1.5 text-start text-[11px]" aria-expanded={open} onClick={toggle}>
        <ListFilter className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="text-muted-foreground">{t("listPick.label", { list: listName })}:</span>
        <span className={cn("min-w-0 truncate", !current && "text-warning")}>{summary}</span>
      </button>
      {open ? (
        <div className="mt-2 space-y-2 text-xs">
          {!current ? <p className="text-[11px] text-warning">{t("listPick.fixedRisk")}</p> : null}
          <fieldset className="space-y-1">
            {(["fixed", "first", "last", "where"] as const).map((value) => (
              <label key={value} className="flex items-center gap-1.5">
                <input type="radio" checked={mode === value} onChange={() => setMode(value)} />
                {value === "fixed" ? t("listPick.modes.fixed", { index: n(split.index + 1) }) : t(`listPick.modes.${value}`)}
              </label>
            ))}
          </fieldset>

          {mode === "where" ? (
            <div className="space-y-1.5 ps-5">
              {help?.anchors.length ? (
                <ul className="space-y-1">
                  {help.anchors.map((anchor, index) => {
                    const chosen = condition && sameCondition(condition, anchor.condition);
                    return (
                      <li key={index}>
                        <label className={cn("flex items-start gap-1.5 rounded border px-1.5 py-1", chosen ? "border-primary/60 bg-primary/5" : "border-border")}>
                          <input type="radio" className="mt-0.5" checked={Boolean(chosen)} onChange={() => setCondition(anchor.condition)} />
                          <span className="min-w-0 space-y-0.5">
                            <span className="flex flex-wrap items-center gap-1">
                              <span className="font-mono" dir="ltr">
                                {anchor.condition.field}
                              </span>
                              <span>{t(`listPick.ops.${anchor.condition.op}`)}</span>
                              <span className="text-muted-foreground">
                                {anchor.preview.otherStep} → <span className="font-mono" dir="ltr">{anchor.preview.otherPath.replace(/^response\.body\./, "")}</span>
                              </span>
                              {anchor.matches === 1 ? (
                                <span className="inline-flex items-center gap-0.5 rounded border border-success/50 px-1 text-[10px] text-success">
                                  <Sparkles className="h-3 w-3" />
                                  {t("listPick.unique")}
                                </span>
                              ) : (
                                <span className="rounded border border-warning/50 px-1 text-[10px] text-warning">{t("listPick.notUnique", { count: n(anchor.matches) })}</span>
                              )}
                            </span>
                            <span className="block truncate text-[10px] text-muted-foreground" dir="ltr">
                              {anchor.preview.itemValue} ⟵ {anchor.preview.otherValue}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : help ? (
                <p className="text-[11px] text-muted-foreground">{t("listPick.noAnchors")}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">{t("listPick.loading")}</p>
              )}
              <CustomCondition value={condition} onChange={setCondition} />
            </div>
          ) : null}

          {help?.preview.length ? (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">{t("listPick.preview", { count: n(help.count) })}</summary>
              <ol className="mt-1 space-y-0.5 font-mono text-[10px]" dir="ltr">
                {help.preview.map((item) => (
                  <li key={item.index} className={cn(item.index === split.index && "text-primary")}>
                    [{item.index}] <BidiText text={item.value} />
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={busy || (mode === "where" && !condition)} onClick={() => void save()}>
              {t("builder.settings.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The same condition, whatever order its fields were saved in. */
function sameCondition(a: PickCondition, b: PickCondition) {
  if (a.field !== b.field || a.op !== b.op) return false;
  if ("text" in a.value || "text" in b.value) return "text" in a.value && "text" in b.value && a.value.text === b.value.text;
  return a.value.source.stepId === b.value.source.stepId && a.value.source.path === b.value.source.path;
}

/** "orders[code in Step 1 → path].id" — a mapping that reads a chosen list item, for one line. */
export function pickPath(path: string, pick: ListPick | undefined) {
  if (!pick) return path;
  const list = pick.list.replace(/^response\.body\.?/, "");
  const where = pick.where?.[0];
  const which = where
    ? `${where.field} ${where.op === "in" ? "∈" : "="} ${"text" in where.value ? where.value.text : where.value.source.path.replace(/^response\.body\./, "")}`
    : pick.position === "last"
      ? "last"
      : "first";
  return `${list}[${which}]${pick.item ? `.${pick.item}` : ""}`;
}

function describeValue(condition: PickCondition) {
  return "text" in condition.value ? condition.value.text : `${condition.value.source.stepName ?? ""} → ${condition.value.source.path.replace(/^response\.body\./, "")}`;
}

/** A condition written by hand: field of the item, how to compare, a text or {{variable}}. */
function CustomCondition({ value, onChange }: { value: PickCondition | null; onChange: (next: PickCondition) => void }) {
  const { t } = useI18n();
  const custom = value && "text" in value.value ? value : null;
  const [field, setField] = useState(custom?.field ?? "");
  const [op, setOp] = useState<PickCondition["op"]>(custom?.op ?? "equals");
  const [text, setText] = useState(custom && "text" in custom.value ? custom.value.text : "");
  const apply = (next: { field?: string; op?: PickCondition["op"]; text?: string }) => {
    const merged = { field: next.field ?? field, op: next.op ?? op, text: next.text ?? text };
    if (merged.field.trim() && merged.text.trim()) onChange({ field: merged.field.trim(), op: merged.op, value: { text: merged.text } });
  };
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">{t("listPick.custom")}</p>
      <div className="flex flex-wrap items-center gap-1">
        <input
          className={cn(input, "w-28 font-mono")}
          dir="ltr"
          placeholder="code"
          aria-label={t("listPick.field")}
          value={field}
          onChange={(event) => {
            setField(event.target.value);
            apply({ field: event.target.value });
          }}
        />
        <select
          className={cn(input, "w-28")}
          aria-label={t("listPick.op")}
          value={op}
          onChange={(event) => {
            setOp(event.target.value as PickCondition["op"]);
            apply({ op: event.target.value as PickCondition["op"] });
          }}
        >
          <option value="equals">{t("listPick.ops.equals")}</option>
          <option value="in">{t("listPick.ops.in")}</option>
        </select>
        <input
          className={cn(input, "w-40 flex-1 font-mono")}
          dir="ltr"
          placeholder="{{orderCode}}"
          aria-label={t("listPick.value")}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            apply({ text: event.target.value });
          }}
        />
      </div>
    </div>
  );
}
