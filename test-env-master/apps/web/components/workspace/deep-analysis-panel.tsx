"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Languages, Sparkles, Square } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useI18n, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type DeepStatus = {
  ai: { ready: boolean; provider: string; model: string; reason: "disabled" | "external_not_allowed" | "missing_api_key" | null };
  job: {
    state: "running" | "done" | "failed" | "cancelled";
    locale: Locale;
    step: string;
    index: number;
    total: number;
    detail?: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    reused?: boolean;
    warning?: string;
  } | null;
  runs: Partial<
    Record<
      Locale,
      {
        createdAt: string;
        provider: string;
        model: string;
        durationMs: number;
        hadExplicitCriteria: boolean;
        criteria: number;
        testCases: number;
        questions: number;
        dropped: { criteria: number; testCases: number };
        current: boolean;
      }
    >
  >;
  translation: { title: string; description: string; acceptanceCriteria: string[] } | null;
  sourceLanguage: Locale | null;
};

const POLL_MS = 1500;

/**
 * "Analyse in Persian" / "Analyse in English": every generated artifact is
 * written in the chosen language whatever language the Jira issue uses. With a
 * model configured the analysis runs in the background (several passes,
 * possibly minutes) and its progress is shown here; without one the
 * rule-based engine runs immediately.
 */
export function DeepAnalysisPanel({
  issueId,
  hasAcceptanceCriteria,
  busy,
  onFallback,
  onFinished,
  onStatus,
}: {
  issueId: string;
  hasAcceptanceCriteria: boolean;
  busy: boolean;
  /** No model available: run the rule-based generation in this language. */
  onFallback: (locale: Locale) => Promise<void>;
  onFinished: () => Promise<void>;
  onStatus: (status: DeepStatus | null) => void;
}) {
  const { t, n, d, locale, err } = useI18n();
  const [status, setStatus] = useState<DeepStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [polling, setPolling] = useState(false);
  // Callbacks from the page change on every render; the polling loop reads the latest through refs.
  const callbacks = useRef({ onFinished, onStatus });
  useEffect(() => {
    callbacks.current = { onFinished, onStatus };
  }, [onFinished, onStatus]);

  const load = useCallback(async () => {
    const next = await api<DeepStatus>(`/analysis/${issueId}/deep?locale=${locale}`);
    setStatus(next);
    callbacks.current.onStatus(next);
    return next;
  }, [issueId, locale]);

  // A job still running when the page opens (reload, another tab) is followed.
  useEffect(() => {
    void load()
      .then((next) => {
        if (next.job?.state === "running") setPolling(true);
      })
      .catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!polling) return;
    let finished = false;
    const id = setInterval(() => {
      void (async () => {
        try {
          const next = await load();
          setNow(Date.now());
          if (finished || next.job?.state === "running") return;
          finished = true;
          setPolling(false);
          if (next.job?.state === "failed") setError(next.job.error ?? "AI analysis failed");
          await callbacks.current.onFinished();
        } catch (e) {
          finished = true;
          setPolling(false);
          setError(e instanceof Error ? e.message : "Request failed");
        }
      })();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [polling, load]);

  const analyse = async (target: Locale) => {
    setError(null);
    try {
      if (!status?.ai.ready) {
        await onFallback(target);
        await load();
        return;
      }
      const next = await api<DeepStatus>(`/analysis/${issueId}/deep`, {
        method: "POST",
        body: JSON.stringify({ locale: target, force: Boolean(status.runs[target]?.current) }),
      });
      setStatus(next);
      setPolling(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  };

  const job = status?.job;
  const running = job?.state === "running";
  const run = status?.runs[locale];
  const elapsed = job ? Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)) / 1000)) : 0;

  return (
    <section className="space-y-2 rounded-md border border-border bg-card p-3" aria-labelledby="deep-analysis-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="deep-analysis-title" className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className={cn("h-4 w-4", status?.ai.ready ? "text-primary" : "text-muted-foreground")} />
          {t("deepAnalysis.title")}
        </h2>
        <div className="ms-auto flex flex-wrap gap-2">
          {(["fa", "en"] as const).map((target) => (
            <Button key={target} variant={target === locale ? "default" : "outline"} disabled={busy || running} onClick={() => void analyse(target)}>
              <Languages className="h-3.5 w-3.5" />
              {t(target === "fa" ? "deepAnalysis.analyzeFa" : "deepAnalysis.analyzeEn")}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {status?.ai.ready
          ? t("deepAnalysis.readyHint", { model: status.ai.model })
          : status
            ? (
                <>
                  {t(`deepAnalysis.notReady.${status.ai.reason ?? "disabled"}`)}{" "}
                  <Link href="/settings" className="text-primary hover:underline">
                    {t("deepAnalysis.openSettings")}
                  </Link>
                </>
              )
            : null}
      </p>
      {!hasAcceptanceCriteria ? <p className="text-[11px] text-warning">{t("deepAnalysis.noAcHint")}</p> : null}

      {running && job ? (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{t(`deepAnalysis.steps.${job.step}`)}</span>
            {job.detail ? <span className="font-mono text-[11px] text-muted-foreground dir-ltr">{job.detail}</span> : null}
            <span className="text-[11px] text-muted-foreground">
              {t("deepAnalysis.progress", { index: n(job.index), total: n(job.total), seconds: n(elapsed) })}
            </span>
            <Button size="sm" variant="ghost" className="ms-auto" onClick={() => void api(`/analysis/${issueId}/deep/cancel`, { method: "POST", body: "{}" })}>
              <Square className="h-3 w-3" />
              {t("deepAnalysis.cancel")}
            </Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.index}>
            <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(4, (job.index / job.total) * 100)}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">{t("deepAnalysis.slowHint")}</p>
        </div>
      ) : null}

      {!running && run ? (
        <p className="text-[11px] text-muted-foreground">
          {t("deepAnalysis.lastRun", {
            when: d(run.createdAt),
            model: run.model,
            criteria: n(run.criteria),
            cases: n(run.testCases),
            questions: n(run.questions),
          })}
          {run.dropped.criteria + run.dropped.testCases > 0
            ? ` · ${t("deepAnalysis.dropped", { count: n(run.dropped.criteria + run.dropped.testCases) })}`
            : ""}
          {!run.current ? ` · ${t("deepAnalysis.outdated")}` : ""}
        </p>
      ) : null}
      {job && !running && job.state !== "done" ? (
        <p className="text-xs text-destructive">{job.state === "cancelled" ? t("deepAnalysis.cancelled") : err(job.error ?? "")}</p>
      ) : null}
      {job && !running && job.state === "done" && job.warning ? (
        <p className="text-xs text-warning">{t("deepAnalysis.fallback", { reason: err(job.warning) })}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}
    </section>
  );
}
