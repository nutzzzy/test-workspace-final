"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import { api, uploadFile } from "@/lib/api";
import type { MediaItem } from "@/components/media-attachments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { BidiText, textDirection } from "@/components/bidi-text";
import { AnalysisRunner } from "@/components/workspace/analysis-runner";
import { AutomationCard, EdgeCaseCard, RiskCard, StrategyView, type AutomationView, type EdgeCase, type RiskView, type Strategy } from "@/components/workspace/artifact-cards";
import { CriteriaPanel, type Criterion } from "@/components/workspace/criteria-panel";
import { DocumentsPanel } from "@/components/workspace/documents-panel";
import { EdgeCasesEmpty } from "@/components/workspace/edge-cases-empty";
import { RequirementsView, type RequirementAnalysis } from "@/components/workspace/requirements-view";
import { StatusBadge, TestCaseCard, type TestCaseView } from "@/components/workspace/test-case-card";
import { useAnalysisRun, type AnalysisScope } from "@/components/workspace/use-analysis-run";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Issue = {
  id: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: Criterion[];
  requirementAnalysis: RequirementAnalysis | null;
  testStrategy: Strategy | null;
  testCases: TestCaseView[];
  edgeCases: EdgeCase[];
  risks: RiskView[];
  automationCandidates: AutomationView[];
  bugs: Array<{ id: string; title: string; severity: string; testCaseId?: string | null }>;
};

type Traceability = {
  coverage: { acceptanceTotal: number; acceptanceCovered: number; requirementCoverage: number | null };
  nodes: Array<{
    id: string;
    key: string;
    text: string;
    testCases: Array<{
      id: string;
      title: string;
      latestStatus: string;
      bugs: Array<{ id: string; title: string; severity: string }>;
      automationCandidates: Array<{ id: string; apiUiRecommendation: string }>;
    }>;
  }>;
  unlinkedTestCases: Array<{ id: string; title: string; latestStatus: string }>;
  failedWithoutBug?: Array<{ id: string; title: string }>;
  gaps?: Array<{ id: string; description: string; severity: string }>;
};

const TAB_IDS = ["overview", "requirements", "strategy", "testCases", "edgeCases", "risks", "automation", "traceability", "runs", "bugs"] as const;
type TabId = (typeof TAB_IDS)[number];
const TAB_LABEL_KEYS: Record<TabId, string> = {
  overview: "workspace.tabOverview",
  requirements: "workspace.tabRequirements",
  strategy: "workspace.tabStrategy",
  testCases: "workspace.tabTestCases",
  edgeCases: "workspace.tabEdgeCases",
  risks: "workspace.tabRisks",
  automation: "workspace.tabAutomation",
  traceability: "workspace.tabTraceability",
  runs: "workspace.tabRuns",
  bugs: "workspace.tabBugs",
};
/** The run each tab's regenerate button starts. */
const TAB_SCOPE: Partial<Record<TabId, AnalysisScope>> = {
  requirements: "requirements",
  strategy: "strategy",
  testCases: "testCases",
  edgeCases: "edgeCases",
  risks: "risks",
  automation: "automation",
};

const EMPTY_MANUAL = { title: "", acceptanceKey: "", preconditions: "", steps: "", expectedResult: "", priority: "MEDIUM" };

export default function WorkspaceDetailPage() {
  const { t, n, p, d, locale, label, err } = useI18n();
  const toast = useToast();
  const params = useParams<{ key: string }>();
  const issueKey = String(params?.key ?? "");
  const [tab, setTab] = useState<TabId>("overview");
  const [issue, setIssue] = useState<Issue | null>(null);
  const [trace, setTrace] = useState<Traceability | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<Record<string, MediaItem[]>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState(EMPTY_MANUAL);
  const [showOriginal, setShowOriginal] = useState(false);
  const [newEdge, setNewEdge] = useState<{ title: string; description: string } | null>(null);

  const statusLabel = (status: string) => {
    const translated = t(`status.${status}`);
    return translated === `status.${status}` ? status : translated;
  };

  const remember = (data: Issue) => {
    setNotes(Object.fromEntries(data.testCases.map((tc) => [tc.id, tc.executionNotes || tc.runs[0]?.notes || ""])));
    setEvidence(Object.fromEntries(data.testCases.map((tc) => [tc.id, tc.executionEvidence || tc.runs[0]?.evidence || ""])));
    const ids = data.testCases.map((tc) => tc.id);
    if (ids.length === 0) {
      setMedia({});
      return;
    }
    void api<MediaItem[]>(`/attachments?ownerKind=TEST_CASE&ownerId=${ids.slice(0, 50).join(",")}`)
      .then((rows) => {
        const grouped: Record<string, MediaItem[]> = {};
        for (const row of rows) grouped[row.ownerId] = [...(grouped[row.ownerId] ?? []), row];
        setMedia(grouped);
      })
      .catch(() => undefined);
  };

  const reload = useCallback(async () => {
    if (!issueKey) return;
    const data = await api<Issue>(`/jira/issues/${issueKey}`);
    setIssue(data);
    remember(data);
    setTrace(await api<Traceability>(`/traceability/${data.id}`).catch(() => null));
  }, [issueKey]);

  const run = useAnalysisRun(issue?.id, locale, async () => {
    await reload();
    toast.notify("success", t("studio.runner.done"));
  });

  useEffect(() => {
    if (!issueKey) return;
    let alive = true;
    (async () => {
      try {
        const data = await api<Issue>(`/jira/issues/${issueKey}`);
        if (!alive) return;
        setIssue(data);
        remember(data);
        const tree = await api<Traceability>(`/traceability/${data.id}`).catch(() => null);
        if (alive) setTrace(tree);
      } catch (e) {
        if (!alive) return;
        const text = e instanceof Error ? err(e.message) : t("common.loadFailed");
        setMessage(text);
        toast.notify("error", text);
      }
    })();
    return () => {
      alive = false;
    };
  }, [issueKey]);

  const guarded = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      const text = e instanceof Error ? err(e.message) : t("errors.failed");
      setMessage(text);
      toast.notify("error", text);
    } finally {
      setBusy(false);
    }
  };

  const syncCases = (ids: string[]) =>
    guarded(async () => {
      if (!issue || ids.length === 0) throw new Error(t("errors.selectTestCase"));
      setSyncing(true);
      try {
        const result = await api<{ results: Array<{ status: string; message?: string }> }>(`/jira/issues/${issue.id}/test-cases/sync`, {
          method: "POST",
          body: JSON.stringify({ testCaseIds: ids }),
        });
        const failed = result.results.find((item) => item.status === "SYNC_FAILED");
        toast.notify(failed ? "error" : "success", failed ? (failed.message ? err(failed.message) : t("workspace.syncPartial")) : t("workspace.syncDone"));
        await reload();
      } finally {
        setSyncing(false);
      }
    });

  const runCase = (testCaseId: string, status: string) =>
    guarded(async () => {
      const created = await api<{ id: string }>("/test-runs", {
        method: "POST",
        body: JSON.stringify({ testCaseId, status, notes: notes[testCaseId] ?? "", evidence: evidence[testCaseId] ?? "" }),
      });
      if (status === "FAILED") {
        try {
          await api(`/bugs/from-run/${created.id}`, { method: "POST", body: "{}" });
        } catch (bugError) {
          toast.notify("error", t("workspace.bugNotCreated", { error: bugError instanceof Error ? err(bugError.message) : t("errors.failed") }));
        }
      }
      await reload();
      setMessage(t("workspace.recorded", { status: statusLabel(status) }));
    });

  const saveNotes = (testCaseId: string) =>
    guarded(async () => {
      await api(`/test-cases/${testCaseId}/execution`, { method: "PATCH", body: JSON.stringify({ notes: notes[testCaseId] ?? "", evidence: evidence[testCaseId] ?? "" }) });
      toast.notify("success", t("workspace.notesSaved"));
    });

  const uploadCaseMedia = (testCaseId: string, files: File[]) =>
    guarded(async () => {
      const created: MediaItem[] = [];
      for (const file of files) created.push(await uploadFile<MediaItem>("/attachments", file, { ownerKind: "TEST_CASE", ownerId: testCaseId }));
      setMedia((prev) => ({ ...prev, [testCaseId]: [...(prev[testCaseId] ?? []), ...created] }));
    });

  const removeCaseMedia = (testCaseId: string, attachmentId: string) => {
    const file = media[testCaseId]?.find((item) => item.id === attachmentId);
    if (!window.confirm(t("common.confirmDelete", { name: file?.filename ?? "" }))) return;
    void guarded(async () => {
      await api(`/attachments/${attachmentId}`, { method: "DELETE" });
      setMedia((prev) => ({ ...prev, [testCaseId]: (prev[testCaseId] ?? []).filter((item) => item.id !== attachmentId) }));
    });
  };

  const saveManual = () =>
    guarded(async () => {
      if (!issue) return;
      const split = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
      await api("/test-cases", {
        method: "POST",
        body: JSON.stringify({
          jiraIssueId: issue.id,
          title: manual.title,
          acceptanceKey: manual.acceptanceKey || undefined,
          preconditions: split(manual.preconditions),
          steps: split(manual.steps),
          expectedResult: manual.expectedResult,
          priority: manual.priority,
        }),
      });
      setManual(EMPTY_MANUAL);
      setManualOpen(false);
      await reload();
    });

  if (!issue) {
    return <p className="text-sm text-muted-foreground">{message ?? (issueKey ? t("workspace.loading", { key: issueKey }) : t("workspace.missingKey"))}</p>;
  }

  // The model's translation of the issue into the workspace language, unless the user wants the original.
  const translation = run.status?.translation && !showOriginal ? run.status.translation : null;
  const official = issue.acceptanceCriteria.filter((item) => item.origin !== "ai" && item.origin !== "derived");
  const shownCriteria = issue.acceptanceCriteria.map((item) => {
    const index = official.indexOf(item);
    return index >= 0 && translation?.acceptanceCriteria[index] ? { ...item, text: translation.acceptanceCriteria[index] } : item;
  });
  const aiReady = Boolean(run.status?.ai.ready);
  const scope = TAB_SCOPE[tab];
  const regenerate = scope ? (
    <Button variant="outline" disabled={run.running || !aiReady} title={!aiReady ? t("studio.runner.notReady") : undefined} onClick={() => void run.start(scope)}>
      <RefreshCw className={cn("h-3.5 w-3.5", run.running && run.status?.job?.scope === scope && "animate-spin")} />
      {t(`studio.regenerate.${scope}`)}
    </Button>
  ) : null;
  const runningBar =
    run.running && tab !== "overview" ? (
      <button type="button" className="w-full rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5 text-start text-xs text-primary" onClick={() => setTab("overview")}>
        {t("studio.runner.runningBar")}
      </button>
    ) : null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <div className="font-mono text-xs text-primary" dir="ltr">
          {issue.key}
        </div>
        <BidiText text={translation?.title || issue.title} className="block break-words text-lg font-semibold" />
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {trace ? (
            <span className="font-mono">
              {t("workspace.coverageLine", {
                pct: p(trace.coverage.requirementCoverage),
                covered: n(trace.coverage.acceptanceCovered),
                total: n(trace.coverage.acceptanceTotal),
              })}
            </span>
          ) : null}
          {run.status?.translation ? (
            <button type="button" className="text-primary hover:underline" onClick={() => setShowOriginal((current) => !current)}>
              {showOriginal ? t("studio.showTranslation") : t("studio.showOriginal")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border pb-2" role="tablist">
        {TAB_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "shrink-0 rounded px-2.5 py-1 text-xs transition-colors",
              tab === id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(TAB_LABEL_KEYS[id])}
          </button>
        ))}
      </div>

      {message ? <p className="text-xs text-muted-foreground">{err(message)}</p> : null}
      {runningBar}

      {tab === "overview" && (
        <div className="space-y-4">
          <AnalysisRunner
            status={run.status}
            error={run.error}
            running={run.running}
            hasAcceptanceCriteria={official.length > 0}
            onStart={(target) => void run.start("all", target)}
            onCancel={() => void run.cancel()}
          />
          <DocumentsPanel issueId={issue.id} onChange={() => void run.reload()} />
          <CriteriaPanel
            issueId={issue.id}
            criteria={shownCriteria}
            running={run.running}
            onChanged={reload}
            onGenerateFor={(key) => {
              setTab("testCases");
              void run.start("testCases", locale, [key]);
            }}
          />
          <details className="rounded-md border border-border bg-card" open={!issue.requirementAnalysis}>
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t("studio.description")}</summary>
            <div className="border-t border-border px-3 py-2">
              <BidiText text={translation?.description || issue.description || t("studio.noDescription")} className="text-sm leading-7" />
            </div>
          </details>
          <ReleaseGate risks={issue.risks} />
        </div>
      )}

      {tab === "requirements" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">{regenerate}</div>
          {issue.requirementAnalysis ? (
            <RequirementsView
              analysis={issue.requirementAnalysis}
              onSave={(patch) => guarded(async () => {
                await api(`/analysis/${issue.id}/requirements`, { method: "PATCH", body: JSON.stringify(patch) });
                await reload();
              })}
            />
          ) : (
            <EmptyState text={t("studio.empty.requirements")} />
          )}
        </div>
      )}

      {tab === "strategy" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">{regenerate}</div>
          {issue.testStrategy ? <StrategyView issueId={issue.id} strategy={issue.testStrategy} onChanged={reload} /> : <EmptyState text={t("studio.empty.strategy")} />}
        </div>
      )}

      {tab === "testCases" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {regenerate}
            <Button variant="outline" onClick={() => setManualOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t("workspace.manualCase")}
            </Button>
            <div className="ms-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={issue.testCases.length > 0 && selectedCases.length === issue.testCases.length}
                  onChange={(event) => setSelectedCases(event.target.checked ? issue.testCases.map((item) => item.id) : [])}
                />
                {t("workspace.selectAll")}
              </label>
              <Button variant="outline" size="sm" disabled={syncing || selectedCases.length === 0} onClick={() => void syncCases(selectedCases)}>
                {syncing ? t("workspace.syncing") : t("workspace.syncSelected", { count: n(selectedCases.length) })}
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("studio.cases.hint")}</p>
          {issue.testCases.length === 0 ? <EmptyState text={t("studio.empty.testCases")} /> : null}
          {groupCases(issue, shownCriteria).map((group) => (
            <section key={group.key} className="space-y-2">
              <h2 className="flex items-start gap-1.5 text-xs font-medium text-muted-foreground">
                {group.key === "unlinked" ? (
                  t("workspace.unlinkedGroup")
                ) : (
                  <>
                    <span className="shrink-0 font-mono text-primary" dir="ltr">
                      {group.key}
                    </span>
                    <BidiText text={group.text} className="min-w-0" />
                  </>
                )}
              </h2>
              {group.cases.map((tc) => (
                <TestCaseCard
                  key={tc.id}
                  testCase={tc}
                  selected={selectedCases.includes(tc.id)}
                  onSelect={(checked) => setSelectedCases((current) => (checked ? [...current, tc.id] : current.filter((id) => id !== tc.id)))}
                  notes={notes[tc.id] ?? ""}
                  evidence={evidence[tc.id] ?? ""}
                  onNotes={(value) => setNotes((prev) => ({ ...prev, [tc.id]: value }))}
                  onEvidence={(value) => setEvidence((prev) => ({ ...prev, [tc.id]: value }))}
                  onSaveNotes={() => void saveNotes(tc.id)}
                  onRun={(status) => void runCase(tc.id, status)}
                  media={media[tc.id] ?? []}
                  onUpload={(files) => void uploadCaseMedia(tc.id, files)}
                  onRemoveMedia={(attachmentId) => removeCaseMedia(tc.id, attachmentId)}
                  busy={busy}
                  onChanged={reload}
                />
              ))}
            </section>
          ))}
        </div>
      )}

      {tab === "edgeCases" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {regenerate}
            <Button variant="outline" onClick={() => setNewEdge({ title: "", description: "" })}>
              <Plus className="h-3.5 w-3.5" />
              {t("studio.edges.add")}
            </Button>
          </div>
          {issue.edgeCases.length === 0 ? (
            <EdgeCasesEmpty issueId={issue.id} generated refreshKey={`${run.status?.runs[locale]?.createdAt ?? ""}`} />
          ) : (
            issue.edgeCases.map((edge) => <EdgeCaseCard key={edge.id} edge={edge} onChanged={reload} />)
          )}
        </div>
      )}

      {tab === "risks" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">{regenerate}</div>
          {issue.risks.length === 0 ? <EmptyState text={t("studio.empty.risks")} /> : issue.risks.map((risk) => <RiskCard key={risk.id} risk={risk} onChanged={reload} />)}
        </div>
      )}

      {tab === "automation" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">{regenerate}</div>
          {issue.automationCandidates.length === 0 ? (
            <EmptyState text={t("studio.empty.automation")} />
          ) : (
            issue.automationCandidates.map((item) => (
              <AutomationCard key={item.id} item={item} caseTitle={issue.testCases.find((tc) => tc.id === item.testCaseId)?.title} onChanged={reload} />
            ))
          )}
        </div>
      )}

      {tab === "traceability" && (
        <div className="space-y-3">
          <Card>
            <CardContent className="flex items-center justify-between p-3 text-sm">
              <span className="text-muted-foreground">{t("workspace.requirementCoverage")}</span>
              <span className="font-mono text-primary">
                {p(trace?.coverage.requirementCoverage)}
                {trace ? (
                  <span className="ms-2 inline-block text-[11px] text-muted-foreground" dir="ltr">
                    {n(trace.coverage.acceptanceCovered)} / {n(trace.coverage.acceptanceTotal)}
                  </span>
                ) : null}
              </span>
            </CardContent>
          </Card>
          {(trace?.nodes ?? []).map((ac) => (
            <Card key={ac.id}>
              <CardHeader>
                <CardTitle className="flex items-start gap-1.5 normal-case">
                  <span className="font-mono text-primary" dir="ltr">
                    {ac.key}
                  </span>
                  <BidiText text={ac.text} className="min-w-0 text-foreground" />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {ac.testCases.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("workspace.noLinkedCases")}</p>
                ) : (
                  ac.testCases.map((tc) => (
                    <div key={tc.id} className="rounded border border-border px-2.5 py-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <BidiText text={tc.title} />
                        <StatusBadge status={tc.latestStatus} label={statusLabel(tc.latestStatus)} />
                      </div>
                      {tc.bugs.map((bug) => (
                        <BidiText key={bug.id} text={`→ ${bug.title} [${label("level", bug.severity)}]`} className="mt-1 block text-[11px] text-destructive" />
                      ))}
                      {tc.automationCandidates.map((item) => (
                        <div key={item.id} className="mt-1 text-[11px] text-muted-foreground">
                          → {t("workspace.automationCandidate", { kind: label("automationLayer", item.apiUiRecommendation) })}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          ))}
          {(trace?.unlinkedTestCases.length ?? 0) > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("workspace.unlinkedCases")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {trace?.unlinkedTestCases.map((tc) => (
                  <div key={tc.id} className="flex justify-between gap-2 text-sm">
                    <BidiText text={tc.title} />
                    <StatusBadge status={tc.latestStatus} label={statusLabel(tc.latestStatus)} />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
          {(trace?.failedWithoutBug?.length ?? 0) > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("workspace.failedWithoutBug")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {trace?.failedWithoutBug?.map((item) => <BidiText key={item.id} text={item.title} className="block text-sm" />)}
              </CardContent>
            </Card>
          ) : null}
          {(trace?.gaps?.length ?? 0) > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("workspace.requirementGaps")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {trace?.gaps?.map((gap) => <BidiText key={gap.id} text={gap.description} className="block text-sm" />)}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

      {tab === "runs" && (
        <div className="space-y-2">
          {issue.testCases.flatMap((tc) =>
            tc.runs.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-2 rounded border border-border px-2.5 py-2 text-sm">
                <div className="min-w-0">
                  <BidiText text={tc.title} className="block" />
                  <div className="text-[10px] text-muted-foreground">
                    {d(item.executedAt)}
                    {item.notes ? <BidiText text={` · ${item.notes}`} /> : null}
                  </div>
                </div>
                <StatusBadge status={item.status} label={statusLabel(item.status)} />
              </div>
            )),
          )}
          {issue.testCases.every((tc) => tc.runs.length === 0) ? <p className="text-sm text-muted-foreground">{t("common.empty")}</p> : null}
        </div>
      )}

      {tab === "bugs" && (
        <div className="space-y-2">
          {issue.bugs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("workspace.noBugsYet")}</p>
          ) : (
            issue.bugs.map((bug) => (
              <div key={bug.id} className="flex items-center justify-between gap-2 rounded border border-border px-2.5 py-2 text-sm">
                <BidiText text={bug.title} />
                <Badge>{label("level", bug.severity)}</Badge>
              </div>
            ))
          )}
        </div>
      )}

      <Dialog
        open={manualOpen}
        title={t("workspace.manualCase")}
        description={t("workspace.manualCaseHint")}
        closeLabel={t("studio.cancel")}
        onClose={() => setManualOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setManualOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy || !manual.title.trim() || !manual.steps.trim() || !manual.expectedResult.trim()} onClick={() => void saveManual()}>
              {t("workspace.saveCase")}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <input className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" dir={textDirection(manual.title)} value={manual.title} placeholder={t("common.name")} onChange={(event) => setManual({ ...manual, title: event.target.value })} />
          <div className="grid gap-2 md:grid-cols-2">
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={manual.acceptanceKey} onChange={(event) => setManual({ ...manual, acceptanceKey: event.target.value })}>
              <option value="">{t("workspace.criterion")}</option>
              {issue.acceptanceCriteria.map((criterion) => (
                <option key={criterion.id} value={criterion.key}>
                  {criterion.key}
                </option>
              ))}
            </select>
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={manual.priority} onChange={(event) => setManual({ ...manual, priority: event.target.value })}>
              {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((priority) => (
                <option key={priority} value={priority}>
                  {label("level", priority)}
                </option>
              ))}
            </select>
          </div>
          {(["preconditions", "steps", "expectedResult"] as const).map((key) => (
            <textarea
              key={key}
              className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              dir={textDirection(manual[key])}
              value={manual[key]}
              placeholder={key === "preconditions" ? t("workspace.manualPreconditionsHint") : key === "steps" ? t("workspace.manualStepsHint") : t("common.expected")}
              onChange={(event) => setManual({ ...manual, [key]: event.target.value })}
            />
          ))}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(newEdge)}
        title={t("studio.edges.add")}
        closeLabel={t("studio.cancel")}
        onClose={() => setNewEdge(null)}
        footer={
          <Button
            disabled={busy || !newEdge?.title.trim()}
            onClick={() =>
              void guarded(async () => {
                await api(`/analysis/${issue.id}/edge-cases/manual`, { method: "POST", body: JSON.stringify(newEdge) });
                setNewEdge(null);
                await reload();
              })
            }
          >
            {t("studio.save")}
          </Button>
        }
      >
        {newEdge ? (
          <div className="space-y-2">
            <input className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" dir={textDirection(newEdge.title)} placeholder={t("common.name")} value={newEdge.title} onChange={(event) => setNewEdge({ ...newEdge, title: event.target.value })} />
            <textarea className="min-h-24 w-full rounded-md border border-border bg-background px-2 py-1 text-sm" dir={textDirection(newEdge.description)} placeholder={t("common.description")} value={newEdge.description} onChange={(event) => setNewEdge({ ...newEdge, description: event.target.value })} />
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

function groupCases(issue: Issue, criteria: Criterion[]) {
  const rank = (type: string) => ["FUNCTIONAL", "NEGATIVE", "BOUNDARY"].indexOf(type) + 1 || 9;
  const groups = criteria.map((ac) => ({
    key: ac.key,
    text: ac.text,
    cases: issue.testCases.filter((tc) => tc.acceptanceLinks.some((link) => link.acceptanceCriterion.key === ac.key)).sort((a, b) => rank(a.type) - rank(b.type)),
  }));
  const linked = new Set(groups.flatMap((group) => group.cases.map((tc) => tc.id)));
  const unlinked = issue.testCases.filter((tc) => !linked.has(tc.id));
  const visible = groups.filter((group) => group.cases.length > 0);
  if (unlinked.length > 0) visible.push({ key: "unlinked", text: "", cases: unlinked });
  return visible;
}

function ReleaseGate({ risks }: { risks: RiskView[] }) {
  const { t } = useI18n();
  const blocking = risks.filter((risk) => risk.releaseBlocking);
  return (
    <Card className={blocking.length > 0 ? "border-destructive/50" : undefined}>
      <CardHeader>
        <CardTitle>{t("workspace.releaseGate")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {blocking.length > 0 ? t("workspace.releaseGateBody") : risks.length > 0 ? t("workspace.releaseGateNone") : t("workspace.releaseGateEmpty")}
        </p>
        {blocking.map((risk) => (
          <div key={risk.id} className="rounded border border-border px-2 py-1.5 text-sm">
            <div className="mb-1 flex flex-wrap gap-1">
              <Badge className="border-destructive/40 bg-destructive/10 text-destructive">{t("workspace.blocksProduction")}</Badge>
              {(risk.acceptanceKeys ?? []).map((key) => (
                <span key={key} className="inline-flex items-center rounded border border-border px-1.5 font-mono text-[10px]" dir="ltr">
                  {key}
                </span>
              ))}
            </div>
            <BidiText text={risk.description} className="block" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
