"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Locale } from "@/lib/i18n";

export type AnalysisScope = "all" | "requirements" | "strategy" | "testCases" | "edgeCases" | "risks" | "automation";
export type StudioStage = "digest" | "understand" | "criteria" | "assessment" | "cases" | "edges" | "translate" | "review" | "automation";

export type StageState = {
  state: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
  tokens?: number;
  origins: Array<{ connectionId: string; name: string; model: string }>;
};

export type AnalysisStatus = {
  ai: { ready: boolean; connections: number; primary: string | null; reason: string | null };
  job: {
    id: string;
    state: "running" | "done" | "failed" | "cancelled";
    scope: AnalysisScope;
    locale: Locale;
    stages: Partial<Record<StudioStage, StageState>>;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    warnings: Array<{ stage: StudioStage; message: string }>;
    dropped?: { criteria: number; cases: number; edges: number };
  } | null;
  runs: Partial<
    Record<
      Locale,
      {
        createdAt: string;
        durationMs: number;
        scope: AnalysisScope;
        current: boolean;
        dropped: { criteria: number; cases: number; edges: number };
        stages: Partial<Record<StudioStage, { state: string; origins: Array<{ name: string; model: string }>; error?: string }>>;
      }
    >
  >;
  translation: { title: string; description: string; acceptanceCriteria: string[] } | null;
  sourceLanguage: Locale | null;
  documents: number;
};

const POLL_MS = 2000;

/**
 * The analysis run of one issue: start a scope in a language, follow its
 * stages, cancel it; `onFinished` runs once when a run ends (to reload data).
 */
export function useAnalysisRun(issueId: string | undefined, locale: Locale, onFinished: () => Promise<void>) {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  const load = useCallback(async () => {
    if (!issueId) return null;
    const next = await api<AnalysisStatus>(`/analysis/${issueId}/run?locale=${locale}`);
    setStatus(next);
    return next;
  }, [issueId, locale]);

  useEffect(() => {
    void load()
      .then((next) => {
        if (next?.job?.state === "running") setPolling(true);
      })
      .catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!polling) return;
    let done = false;
    const id = setInterval(() => {
      void (async () => {
        try {
          const next = await load();
          if (done || !next || next.job?.state === "running") return;
          done = true;
          setPolling(false);
          if (next.job?.state === "failed") setError(next.job.error ?? "AI analysis failed");
          await finished.current();
        } catch (e) {
          done = true;
          setPolling(false);
          setError(e instanceof Error ? e.message : "Request failed");
        }
      })();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [polling, load]);

  const start = useCallback(
    async (scope: AnalysisScope, targetLocale: Locale = locale, acceptanceKeys?: string[]) => {
      if (!issueId) return;
      setError(null);
      try {
        const next = await api<AnalysisStatus>(`/analysis/${issueId}/run`, {
          method: "POST",
          body: JSON.stringify({ scope, locale: targetLocale, ...(acceptanceKeys?.length ? { acceptanceKeys } : {}) }),
        });
        setStatus(next);
        setPolling(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
      }
    },
    [issueId, locale],
  );

  const cancel = useCallback(async () => {
    if (!issueId) return;
    await api(`/analysis/${issueId}/run/cancel`, { method: "POST", body: "{}" }).catch(() => undefined);
    await load();
  }, [issueId, load]);

  return { status, error, running: status?.job?.state === "running", start, cancel, reload: load };
}
