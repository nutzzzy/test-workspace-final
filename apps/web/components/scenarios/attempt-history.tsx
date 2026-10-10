"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { shortPath, type RecoveryAttempt, type StepOutput } from "@/components/scenarios/builder-types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const MASKED = /^\*\*\*$|^Bearer \*\*\*$/;

function statusTone(code: number | null, met: boolean) {
  if (met) return "text-success";
  if (code === null) return "text-muted-foreground";
  return code >= 500 ? "text-destructive" : "text-warning";
}

/** Compact history of retries: what changed, what came back, why it stopped. */
export function AttemptHistory({ output }: { output: StepOutput | null }) {
  const { t, n, err } = useI18n();
  const trace = output?.recovery;

  if (output?.blocked?.length) {
    return (
      <div className="space-y-2">
        <p className="rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">{t("builder.attempts.blocked")}</p>
      </div>
    );
  }
  if (!trace || (trace.attempts.length === 0 && !trace.stoppedBecause)) {
    return <p className="text-xs text-muted-foreground">{t("builder.attempts.none")}</p>;
  }

  const describe = (attempt: RecoveryAttempt) =>
    (attempt.candidate.changes?.length ? attempt.candidate.changes : [attempt.candidate]).map((change) => {
      const value = MASKED.test(change.replacement) ? "••••••" : change.replacement;
      return change.source.orderIndex >= 0
        ? t("builder.attempts.changedFrom", {
            field: change.fieldName,
            value,
            n: n(change.source.orderIndex + 1),
            path: shortPath(change.source.path),
          })
        : t("builder.attempts.changedCustom", { field: change.fieldName, value });
    });

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        {t("builder.attempts.limit", { n: n(trace.maxAttempts) })}
        {trace.stoppedBecause ? ` · ${t("builder.attempts.stopped", { reason: t(`builder.attempts.stopReasons.${trace.stoppedBecause}`) })}` : ""}
      </p>
      <ol className="space-y-1.5">
        {trace.original ? (
          <li className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs">
            <span className="text-muted-foreground">{t("builder.attempts.original")}</span>
            <span className={cn("font-mono", statusTone(trace.original.status, false))}>{trace.original.status ?? "—"}</span>
            {trace.original.message ? <span className="min-w-0 truncate text-muted-foreground">{trace.original.message}</span> : null}
          </li>
        ) : null}
        {trace.attempts.map((attempt, index) => (
          <AttemptRow key={index} index={index} attempt={attempt} changes={describe(attempt)} errorText={attempt.error ? err(attempt.error) : undefined} />
        ))}
      </ol>
      {trace.savedMapping ? <p className="text-[11px] text-success">{t("builder.attempts.savedMapping")}</p> : null}
      {trace.suggestions.length > 0 && trace.stoppedBecause !== "SUCCESS" ? (
        <p className="text-[11px] text-muted-foreground">{t("builder.attempts.suggestionsLeft", { count: n(trace.suggestions.length) })}</p>
      ) : null}
    </div>
  );
}

function AttemptRow({
  index,
  attempt,
  changes,
  errorText,
}: {
  index: number;
  attempt: RecoveryAttempt;
  changes: string[];
  errorText?: string;
}) {
  const { t, n } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <li className={cn("rounded-md border px-3 py-1.5", attempt.expectationMet ? "border-success/40" : "border-border")}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 text-start text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100", open && "rotate-90")} />
        <span className="font-medium">
          {attempt.manual ? t("builder.attempts.manual") : t("builder.attempts.attempt", { n: n(index + 1) })}
        </span>
        <span className={cn("font-mono", statusTone(attempt.status, attempt.expectationMet))}>{attempt.status ?? "—"}</span>
        {attempt.durationMs !== undefined ? (
          <span className="text-[11px] text-muted-foreground">{t("builder.flow.ms", { value: n(attempt.durationMs) })}</span>
        ) : null}
        <span className="basis-full break-all ps-5 text-[11px] text-muted-foreground">{changes.join(" · ")}</span>
        {errorText || (!attempt.expectationMet && attempt.message) ? (
          <span className="basis-full ps-5 text-[11px] text-destructive">{errorText ?? attempt.message}</span>
        ) : null}
      </button>
      {open && attempt.request ? (
        <div className="mt-1.5 space-y-1 ps-5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("builder.attempts.request")}</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2 font-mono text-[10px] text-muted-foreground dir-ltr" dir="ltr">
            {JSON.stringify(attempt.request, null, 2)}
          </pre>
        </div>
      ) : null}
    </li>
  );
}
