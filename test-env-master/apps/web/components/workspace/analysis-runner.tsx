"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Circle, Languages, Loader2, MinusCircle, Sparkles, Square, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AnalysisStatus, StageState, StudioStage } from "@/components/workspace/use-analysis-run";
import { QualityReport } from "@/components/workspace/quality-report";
import { useI18n, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The API's note for an answer cut at the service's length limit. */
const ANSWER_CAPPED = "The service limits the answer length; the complete part of the answer was kept";

const ORDER: StudioStage[] = ["digest", "understand", "criteria", "assessment", "cases", "edges", "translate", "review", "automation"];

function StageIcon({ state }: { state: StageState["state"] }) {
  if (state === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (state === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  if (state === "failed") return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (state === "skipped") return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />;
}

/**
 * Start the analysis in Persian or English — every artifact is written in that
 * language, whatever language the issue uses — and follow it stage by stage.
 */
export function AnalysisRunner({
  status,
  error,
  running,
  hasAcceptanceCriteria,
  onStart,
  onCancel,
}: {
  status: AnalysisStatus | null;
  error: string | null;
  running: boolean;
  hasAcceptanceCriteria: boolean;
  onStart: (locale: Locale) => void;
  onCancel: () => void;
}) {
  const { t, n, d, locale, err } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const job = status?.job;
  const ready = Boolean(status?.ai.ready);
  const last = status?.runs[locale];
  const elapsed = job ? Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)) / 1000)) : 0;
  const stages = job ? ORDER.filter((stage) => job.stages[stage]) : [];
  const models = last
    ? [...new Set(Object.values(last.stages).flatMap((stage) => (stage?.origins ?? []).map((origin) => `${origin.name} · ${origin.model}`)))]
    : [];

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-3" aria-labelledby="analysis-runner-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="analysis-runner-title" className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className={cn("h-4 w-4", ready ? "text-primary" : "text-muted-foreground")} />
          {t("studio.runner.title")}
        </h2>
        <div className="ms-auto flex flex-wrap gap-2">
          {(["fa", "en"] as const).map((target) => (
            <Button key={target} variant={target === locale ? "default" : "outline"} disabled={running || !ready} onClick={() => onStart(target)}>
              <Languages className="h-3.5 w-3.5" />
              {t(target === "fa" ? "studio.runner.analyzeFa" : "studio.runner.analyzeEn")}
            </Button>
          ))}
        </div>
      </div>

      {!status ? null : !ready ? (
        <p className="rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          {t("studio.runner.notReady")}{" "}
          <Link href="/settings" className="font-medium text-primary hover:underline">
            {t("studio.runner.openSettings")}
          </Link>
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {t("studio.runner.engines", { count: n(status.ai.connections), primary: status.ai.primary ?? "—" })}
        </p>
      )}
      {!hasAcceptanceCriteria ? <p className="text-[11px] text-muted-foreground">{t("studio.runner.noAcHint")}</p> : null}

      {job && (running || job.state !== "done" || job.warnings.length > 0) ? (
        <div className="space-y-2 rounded-md border border-border p-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">
              {t(`studio.runner.scope.${job.scope}`)} · {job.locale === "fa" ? t("studio.runner.inFa") : t("studio.runner.inEn")}
            </span>
            <span className="text-muted-foreground">{t("studio.runner.elapsed", { time: formatDuration(elapsed, n) })}</span>
            {running ? (
              <Button size="sm" variant="ghost" className="ms-auto" onClick={onCancel}>
                <Square className="h-3 w-3" />
                {t("studio.runner.cancel")}
              </Button>
            ) : null}
          </div>
          <ol className="grid gap-1 sm:grid-cols-2">
            {stages.map((stage) => {
              const entry = job.stages[stage]!;
              return (
                <li key={stage} className="flex min-w-0 items-center gap-1.5 text-xs">
                  <StageIcon state={entry.state} />
                  <span className={cn(entry.state === "pending" && "text-muted-foreground")}>{t(`studio.stages.${stage}`)}</span>
                  {entry.detail ? (
                    <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" dir="ltr" title={entry.detail}>
                      {entry.detail}
                    </span>
                  ) : null}
                  {entry.state === "running" && entry.tokens ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{t("studio.runner.tokens", { count: n(entry.tokens) })}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {running ? <p className="text-[11px] text-muted-foreground">{t("studio.runner.slowHint")}</p> : null}
          {job.state === "failed" ? <p className="text-xs text-destructive">{err(job.error ?? "")}</p> : null}
          {job.state === "cancelled" ? <p className="text-xs text-muted-foreground">{t("studio.runner.cancelled")}</p> : null}
          {job.warnings
            .filter((warning) => warning.message !== ANSWER_CAPPED)
            .map((warning, index) => (
              <p key={`${warning.stage}-${index}`} className="flex items-start gap-1 text-[11px] text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  {t(`studio.stages.${warning.stage}`)}: {err(warning.message)}
                </span>
              </p>
            ))}
          {/* Normal on free tiers: one quiet note instead of a warning per stage. */}
          {job.warnings.some((warning) => warning.message === ANSWER_CAPPED) ? (
            <p className="text-[11px] text-muted-foreground">
              {job.warnings
                .filter((warning) => warning.message === ANSWER_CAPPED)
                .map((warning) => t(`studio.stages.${warning.stage}`))
                .join(locale === "fa" ? "، " : ", ")}
              : {err(ANSWER_CAPPED)}
            </p>
          ) : null}
        </div>
      ) : null}

      {!running && last ? (
        <p className="text-[11px] text-muted-foreground">
          {t("studio.runner.lastRun", { when: d(last.createdAt), duration: formatDuration(Math.round(last.durationMs / 1000), n) })}
          {models.length ? ` · ${models.join(" · ")}` : ""}
          {last.dropped.criteria + last.dropped.cases + last.dropped.edges > 0
            ? ` · ${t("studio.runner.reviewed", { count: n(last.dropped.criteria + last.dropped.cases + last.dropped.edges) })}`
            : ""}
          {!last.current ? ` · ${t("studio.runner.outdated")}` : ""}
        </p>
      ) : null}
      {/* The live comparison while a run goes; afterwards the report of the last run in this language. */}
      {job?.quality && (running || job.locale === locale) ? (
        <QualityReport report={job.quality} running={running} />
      ) : !running && last?.quality ? (
        <QualityReport report={last.quality} running={false} />
      ) : null}
      {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}
    </section>
  );
}

function formatDuration(seconds: number, n: (value: number) => string) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${n(minutes)}:${rest < 10 ? n(0) : ""}${n(rest)}` : `${n(rest)}s`;
}
