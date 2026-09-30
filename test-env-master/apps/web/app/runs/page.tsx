"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

type Run = {
  id: string;
  status: string;
  executedAt: string;
  testCase: { title: string };
};

export default function RunsPage() {
  const { t, d, err } = useI18n();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Run[]>("/test-runs")
      .then(setRuns)
      .catch((e: Error) => {
        // A failed load is not the same as "no runs yet".
        setError(e.message);
        setRuns([]);
      });
  }, []);

  const statusLabel = (status: string) => {
    const key = `status.${status}`;
    const translated = t(key);
    return translated === key ? status : translated;
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{t("runs.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("runs.subtitle")}</p>
      </div>
      <div className="space-y-2">
        {error ? <p className="text-sm text-destructive">{err(error)}</p> : null}
        {runs === null ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : null}
        {runs !== null && runs.length === 0 && !error ? (
          <p className="text-sm text-muted-foreground">{t("runs.empty")}</p>
        ) : null}
        {runs !== null && runs.length === 200 ? (
          <p className="text-xs text-muted-foreground">{t("runs.limited", { count: 200 })}</p>
        ) : null}
        {(runs ?? []).map((run) => (
          <Card key={run.id}>
            <CardContent className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div>{run.testCase.title}</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {d(run.executedAt)}
                </div>
              </div>
              <Badge>{statusLabel(run.status)}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
