"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

type Suite = {
  id: string;
  name: string;
  kind: string;
  description: string;
  cases: Array<{
    testCaseId: string;
    testCase: {
      id: string;
      title: string;
      runs?: Array<{ status: string }>;
    };
  }>;
};

type TestCase = { id: string; title: string };

export default function SuitesPage() {
  const { t, err, label } = useI18n();
  const [suites, setSuites] = useState<Suite[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [selectedSuite, setSelectedSuite] = useState("");
  const [selectedCase, setSelectedCase] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /** Run one mutation at a time and show its failure instead of dropping it. */
  const act = async (task: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      await task();
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setPending(false);
    }
  };

  const reload = async () => {
    const [suiteList, caseList] = await Promise.all([
      api<Suite[]>("/test-suites"),
      api<TestCase[]>("/test-cases"),
    ]);
    setSuites(suiteList);
    setCases(caseList);
  };

  useEffect(() => {
    void reload().catch((e: Error) => setMessage(e.message));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{t("suites.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("suites.subtitle")}
        </p>
      </div>

      {message ? <p className="text-xs text-destructive">{err(message)}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("suites.createSuite")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <input
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("common.name")}
          />
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">{t("common.select")}</option>
            <option value="SMOKE">{label("suiteKind", "SMOKE")}</option>
            <option value="REGRESSION">{label("suiteKind", "REGRESSION")}</option>
            <option value="CUSTOM">{label("suiteKind", "CUSTOM")}</option>
          </select>
          <Button
            disabled={pending || !name.trim() || !kind}
            title={!name.trim() || !kind ? t("suites.createHint") : undefined}
            onClick={() =>
              act(async () => {
                await api("/test-suites", {
                  method: "POST",
                  body: JSON.stringify({ name, kind }),
                });
                setName("");
                setKind("");
              })
            }
          >
            {t("common.create")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("suites.addCase")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <select
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
            value={selectedSuite}
            onChange={(e) => setSelectedSuite(e.target.value)}
          >
            <option value="">{t("common.select")}</option>
            {suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
            value={selectedCase}
            onChange={(e) => setSelectedCase(e.target.value)}
          >
            <option value="">{t("suites.selectCase")}</option>
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <Button
            disabled={pending || !selectedSuite || !selectedCase}
            title={!selectedSuite || !selectedCase ? t("suites.addHint") : undefined}
            onClick={() =>
              act(() =>
                api(`/test-suites/${selectedSuite}/cases`, {
                  method: "POST",
                  body: JSON.stringify({ testCaseId: selectedCase }),
                }),
              )
            }
          >
            {t("suites.addCase")}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {suites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
        ) : null}
        {suites.map((suite) => (
          <Card key={suite.id}>
            <CardContent className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{suite.name}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {t("suites.casesLine", {
                      kind: label("suiteKind", suite.kind),
                      count: suite.cases.length,
                    })}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    if (!window.confirm(t("suites.confirmDelete", { name: suite.name }))) return;
                    void act(() => api(`/test-suites/${suite.id}`, { method: "DELETE" }));
                  }}
                >
                  {t("common.delete")}
                </Button>
              </div>
              {suite.cases.map((link) => (
                <div
                  key={link.testCaseId}
                  className="flex flex-col gap-2 rounded border border-border px-2 py-1.5 text-xs sm:flex-row sm:items-center sm:justify-between"
                >
                  <span>{link.testCase.title}</span>
                  <div className="flex items-center gap-2">
                    <Badge>
                      {(() => {
                        const st =
                          link.testCase.runs?.[0]?.status ?? "NOT_RUN";
                        const key = `status.${st}`;
                        const translated = t(key);
                        return translated === key ? st : translated;
                      })()}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(t("suites.confirmRemove", { name: link.testCase.title }))) return;
                        void act(() =>
                          api(`/test-suites/${suite.id}/cases/${link.testCaseId}`, {
                            method: "DELETE",
                          }),
                        );
                      }}
                    >
                      {t("common.remove")}
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
