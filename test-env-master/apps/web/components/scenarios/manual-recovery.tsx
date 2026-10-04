"use client";

import { useMemo, useState } from "react";
import { PauseCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sameTarget, shortPath, type ManualOptions, type StepOutput } from "@/components/scenarios/builder-types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ManualChoice = {
  target: { location: string; field: string };
  source: { ref: string } | { value: string };
  save: boolean;
};

/**
 * A paused run waits here: pick the field and the value (a suggested one, any
 * value an earlier response produced, or a typed one), then retry. Secret
 * values are never shown; they are chosen by reference.
 */
export function ManualRecovery({
  output,
  error,
  onRetry,
  onSkip,
}: {
  output: StepOutput | null;
  error?: string | null;
  onRetry: (choice: ManualChoice) => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const { t, n, err } = useI18n();
  const manual: ManualOptions | undefined = output?.manual;
  const likely = manual?.likelyField ?? null;
  const targets = manual?.targets ?? [];
  const initial = likely ? targets.findIndex((target) => sameTarget(target, likely)) : 0;
  const [targetIndex, setTargetIndex] = useState(Math.max(0, initial));
  const [ref, setRef] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [query, setQuery] = useState("");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);

  const target = targets[targetIndex];
  const recommended = (manual?.recommended ?? []).filter((item) => target && sameTarget(item.target, target));
  const values = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = manual?.values ?? [];
    return needle
      ? list.filter(
          (value) =>
            value.path.toLowerCase().includes(needle) ||
            value.key.toLowerCase().includes(needle) ||
            (!value.secret && value.display.toLowerCase().includes(needle)),
        )
      : list;
  }, [manual, query]);
  const groups = useMemo(() => {
    const byStep = new Map<number, typeof values>();
    for (const value of values) byStep.set(value.orderIndex, [...(byStep.get(value.orderIndex) ?? []), value]);
    return [...byStep.entries()].sort((a, b) => a[0] - b[0]);
  }, [values]);

  if (!manual || !target) return null;
  const choice = custom.trim() ? { value: custom.trim() } : ref ? { ref } : null;

  const submit = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      await onRetry({ target: { location: target.location, field: target.field }, source: choice, save });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-warning/50 bg-warning/5 p-3" aria-labelledby="manual-recovery-title">
      <div className="flex items-start gap-2">
        <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <h3 id="manual-recovery-title" className="text-sm font-medium">
            {t("builder.recovery.title")}
          </h3>
          <p className="text-[11px] text-muted-foreground">{t("builder.recovery.hint")}</p>
        </div>
      </div>
      {error ? (
        <p className="text-xs">
          <span className="text-muted-foreground">{t("builder.recovery.failure")}: </span>
          <span className="text-destructive">{err(error)}</span>
        </p>
      ) : null}

      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">
          {likely ? t("builder.recovery.likely", { field: likely.fieldName }) : t("builder.recovery.field")}
        </span>
        <select
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
          value={targetIndex}
          onChange={(event) => {
            setTargetIndex(Number(event.target.value));
            setRef(null);
          }}
        >
          {targets.map((item, index) => (
            <option key={`${item.location}:${item.field}`} value={index}>
              {t(`builder.picker.locations.${item.location}`)} · {item.key} = {item.display}
            </option>
          ))}
        </select>
      </label>

      {recommended.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">{t("builder.recovery.recommended")}</div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("builder.recovery.recommended")}>
            {recommended.map((item) => (
              <button
                key={item.ref}
                type="button"
                role="radio"
                aria-checked={ref === item.ref && !custom}
                className={cn(
                  "max-w-full rounded-md border px-2 py-1 text-start text-[11px]",
                  ref === item.ref && !custom ? "border-primary bg-primary/15" : "border-border hover:bg-accent",
                )}
                onClick={() => {
                  setRef(item.ref);
                  setCustom("");
                }}
              >
                <span className="font-mono dir-ltr">{item.display}</span>
                <span className="ms-1 text-muted-foreground">
                  {t("builder.flow.step", { n: n(item.orderIndex + 1) })} · {shortPath(item.path)}
                  {item.tried ? ` · ${t("builder.recovery.tried")}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <details className="rounded-md border border-border bg-background">
        <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-muted-foreground">{t("builder.recovery.allValues")}</summary>
        <div className="space-y-2 p-2">
          {manual.values.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("builder.recovery.noValues")}</p>
          ) : (
            <>
              <label className="relative block">
                <span className="sr-only">{t("builder.recovery.search")}</span>
                <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="h-8 w-full rounded-md border border-border bg-background ps-7 pe-2 text-xs"
                  value={query}
                  placeholder={t("builder.recovery.search")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="max-h-56 space-y-2 overflow-auto" role="radiogroup" aria-label={t("builder.recovery.allValues")}>
                {groups.map(([orderIndex, list]) => (
                  <div key={orderIndex}>
                    <div className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("builder.flow.step", { n: n(orderIndex + 1) })} · {list[0]?.stepName}
                    </div>
                    {list.map((value) => (
                      <button
                        key={value.ref}
                        type="button"
                        role="radio"
                        aria-checked={ref === value.ref && !custom}
                        className={cn(
                          "flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-start font-mono text-[11px] dir-ltr",
                          ref === value.ref && !custom ? "bg-primary/15" : "hover:bg-accent",
                        )}
                        onClick={() => {
                          setRef(value.ref);
                          setCustom("");
                        }}
                      >
                        <span className="shrink-0 text-muted-foreground">{shortPath(value.path)}</span>
                        <span className={cn("min-w-0 break-all", value.secret && "text-warning")}>{value.display}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </details>

      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">{t("builder.recovery.custom")}</span>
        <input
          className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs"
          dir="ltr"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} />
          {t("builder.recovery.save")}
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onSkip()}>
            {t("builder.recovery.skip")}
          </Button>
          <Button size="sm" disabled={busy || !choice} onClick={() => void submit()}>
            {t("builder.recovery.retry")}
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground" aria-live="polite">
        {t("builder.recovery.waiting")}
      </p>
    </section>
  );
}
