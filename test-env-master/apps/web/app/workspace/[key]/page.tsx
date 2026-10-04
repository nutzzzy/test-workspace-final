"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, uploadFile } from "@/lib/api";
import { MediaGallery, MediaPicker, type MediaItem } from "@/components/media-attachments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressBanner } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { DeepAnalysisPanel, type DeepStatus } from "@/components/workspace/deep-analysis-panel";
import { EdgeCasesEmpty } from "@/components/workspace/edge-cases-empty";
import { useAsyncProgress } from "@/hooks/use-async-progress";
import { useI18n } from "@/lib/i18n";
import { BidiText } from "@/components/bidi-text";

type Issue = {
  id: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: Array<{
    id: string;
    key: string;
    text: string;
    origin?: string;
  }>;
  requirementAnalysis: {
    summary: string;
    gaps: string[];
    ambiguities: string[];
    missingScenarios: string[];
    potentialRisks: string[];
    questionsProduct: string[];
    questionsDeveloper: string[];
    questionsBusiness: string[];
    /** Why each question was asked (older analyses may not have it). */
    questionDetails?: Array<{ question: string; category: string; reason: string; source: string }>;
    suggestedCriteria?: Array<{
      text: string;
      reason: string;
      source: string;
      /** Present on AI-proposed criteria. */
      confidence?: "HIGH" | "MEDIUM" | "LOW";
      evidence?: string;
      grounded?: boolean;
      needsConfirmation?: boolean;
    }>;
  } | null;
  testStrategy: {
    scope: string;
    objectives: string[];
    testTypes: string[];
    environments: string[];
    dependencies: string[];
    assumptions: string[];
  } | null;
  testCases: Array<{
    id: string;
    title: string;
    priority: string;
    type: string;
    steps: string[];
    stepExpectations?: string[];
    testData?: string[];
    description?: string;
    expectedResult: string;
    preconditions: string[];
    tags?: string[];
    designStatus?: string;
    technique?: string;
    gapRefs?: string[];
    assumptions?: string[];
    automationSuitability?: string | null;
    automationNotes?: string;
    executionNotes?: string;
    executionEvidence?: string;
    jiraSyncStatus?: string;
    jiraSyncError?: string | null;
    jiraSyncedAt?: string | null;
    acceptanceLinks: Array<{
      acceptanceCriterion: { key: string; text: string };
    }>;
    runs: Array<{
      id: string;
      status: string;
      notes?: string | null;
      evidence?: string | null;
      executedAt: string;
    }>;
  }>;
  edgeCases: Array<{ id: string; title: string; description: string }>;
  risks: Array<{
    id: string;
    description: string;
    impact: string;
    likelihood: string;
    mitigation: string;
    releaseBlocking?: boolean;
    acceptanceKeys?: string[];
  }>;
  automationCandidates: Array<{
    id: string;
    recommendedLevel: string;
    apiUiRecommendation: string;
    reasoning: string;
  }>;
  bugs: Array<{
    id: string;
    title: string;
    severity: string;
    testCaseId?: string | null;
  }>;
};

type Traceability = {
  coverage: {
    acceptanceTotal: number;
    acceptanceCovered: number;
    /** null when the issue has no acceptance criteria (not measurable). */
    requirementCoverage: number | null;
  };
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
  uncoveredAcceptance?: Array<{ id: string; key: string; text: string }>;
  failedWithoutBug?: Array<{ id: string; title: string }>;
  gaps?: Array<{ id: string; description: string; severity: string }>;
};

const TAB_IDS = [
  "overview",
  "requirements",
  "strategy",
  "testCases",
  "edgeCases",
  "risks",
  "automation",
  "traceability",
  "runs",
  "bugs",
] as const;

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

const STATUSES = ["PASSED", "FAILED", "BLOCKED", "SKIPPED"] as const;

export default function WorkspaceDetailPage() {
  const { t, n, p, d, locale, label, err } = useI18n();
  const toast = useToast();
  const progress = useAsyncProgress();
  const params = useParams<{ key: string }>();
  const issueKey = String(params?.key ?? "");
  const [tab, setTab] = useState<TabId>("overview");
  const [issue, setIssue] = useState<Issue | null>(null);
  const [trace, setTrace] = useState<Traceability | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [acKey, setAcKey] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<Record<string, MediaItem[]>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [deep, setDeep] = useState<DeepStatus | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [manual, setManual] = useState({
    title: "",
    acceptanceKey: "",
    preconditions: "",
    steps: "",
    expectedResult: "",
    priority: "MEDIUM",
  });

  const busy = progress.busy;

  const statusLabel = (status: string) => {
    const key = `status.${status}`;
    const translated = t(key);
    return translated === key ? status : translated;
  };

  const remember = (data: Issue) => {
    setNotes(
      Object.fromEntries(
        data.testCases.map((tc) => [tc.id, tc.executionNotes || tc.runs[0]?.notes || ""]),
      ),
    );
    setEvidence(
      Object.fromEntries(
        data.testCases.map((tc) => [tc.id, tc.executionEvidence || tc.runs[0]?.evidence || ""]),
      ),
    );
    const ids = data.testCases.map((tc) => tc.id);
    if (ids.length === 0) {
      setMedia({});
      return;
    }
    void api<MediaItem[]>(`/attachments?ownerKind=TEST_CASE&ownerId=${ids.join(",")}`)
      .then((rows) => {
        const grouped: Record<string, MediaItem[]> = {};
        for (const row of rows) {
          grouped[row.ownerId] = [...(grouped[row.ownerId] ?? []), row];
        }
        setMedia(grouped);
      })
      .catch(() => undefined);
  };

  const reload = async () => {
    if (!issueKey) return;
    const data = await api<Issue>(`/jira/issues/${issueKey}`);
    setIssue(data);
    remember(data);
    const tree = await api<Traceability>(`/traceability/${data.id}`);
    setTrace(tree);
  };

  useEffect(() => {
    if (!issueKey) return;
    let alive = true;
    setMessage(null);
    (async () => {
      try {
        // Loading a page is read-only. Imported requirement text is never
        // rewritten for the UI language; generation uses the locale only
        // for the wording of newly generated artifacts.
        const data = await api<Issue>(`/jira/issues/${issueKey}`);
        if (!alive) return;
        setIssue(data);
        remember(data);
        try {
          const tree = await api<Traceability>(`/traceability/${data.id}`);
          if (alive) setTrace(tree);
        } catch {
          // optional
        }
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
  }, [issueKey, t, locale, err, toast]);

  const generate = async (
    path: string,
    mode?: "all" | "missing" | "drafts",
    acceptanceKeys?: string[],
    targetLocale: string = locale,
  ) => {
    if (!issue) return;
    setMessage(null);
    try {
      await progress.run(
        [
          { to: 20, label: t("common.processing") },
          { to: 55, label: t("workspace.aiStep", { path }) },
          { to: 85, label: t("jira.progressReload") },
        ],
        async () => {
          await api(`/analysis/${issue.id}/${path}`, {
            method: "POST",
            body: JSON.stringify({
              locale: targetLocale,
              ...(mode ? { mode } : {}),
              ...(acceptanceKeys?.length ? { acceptanceKeys } : {}),
            }),
          });
          await reload();
        },
        { successLabel: t("common.progressDone") },
      );
      const text = t("workspace.generated", { path });
      setMessage(text);
      toast.notify("success", text);
    } catch (e) {
      const text =
        e instanceof Error && e.message ? err(e.message) : t("workspace.generationFailed");
      setMessage(text);
      toast.notify("error", text);
    }
  };

  const syncCases = async (ids: string[]) => {
    if (!issue || ids.length === 0) {
      toast.notify("error", t("errors.selectTestCase"));
      return;
    }
    setSyncing(true);
    try {
      const result = await api<{
        results: Array<{ status: string; message?: string }>;
      }>(`/jira/issues/${issue.id}/test-cases/sync`, {
        method: "POST",
        body: JSON.stringify({ testCaseIds: ids }),
      });
      const failed = result.results.filter((item) => item.status === "SYNC_FAILED");
      if (failed.length > 0) {
        const text = failed[0]?.message
          ? err(failed[0].message)
          : t("workspace.syncPartial");
        setMessage(text);
        toast.notify("error", text);
      } else {
        setMessage(t("workspace.syncDone"));
        toast.notify("success", t("workspace.syncDone"));
      }
      await reload();
    } catch (error) {
      const text = error instanceof Error ? err(error.message) : t("errors.jiraUpdateFailed");
      setMessage(text);
      toast.notify("error", text);
    } finally {
      setSyncing(false);
    }
  };

  const runCase = async (testCaseId: string, status: string) => {
    let bugFailure: string | null = null;
    try {
      await progress.run(
        [
          { to: 30, label: t("common.processing") },
          { to: 70, label: statusLabel(status) },
          { to: 90, label: t("jira.progressReload") },
        ],
        async () => {
          const run = await api<{ id: string }>("/test-runs", {
            method: "POST",
            body: JSON.stringify({
              testCaseId,
              status,
              notes: notes[testCaseId] ?? "",
              evidence: evidence[testCaseId] ?? "",
            }),
          });
          if (status === "FAILED") {
            try {
              await api(`/bugs/from-run/${run.id}`, {
                method: "POST",
                body: "{}",
              });
            } catch (bugError) {
              // The run itself is saved; say so instead of reporting the
              // whole action as failed (a retry would record a second run).
              bugFailure = bugError instanceof Error ? err(bugError.message) : t("errors.failed");
            }
          }
          await reload();
        },
        { successLabel: t("common.progressDone") },
      );
      if (bugFailure) {
        const text = t("workspace.bugNotCreated", { error: bugFailure });
        setMessage(text);
        toast.notify("error", text);
      } else {
        setMessage(t("workspace.recorded", { status: statusLabel(status) }));
      }
    } catch (e) {
      setMessage(e instanceof Error ? err(e.message) : t("workspace.runFailed"));
    }
  };

  const saveNotes = async (testCaseId: string) => {
    try {
      await api(`/test-cases/${testCaseId}/execution`, {
        method: "PATCH",
        body: JSON.stringify({
          notes: notes[testCaseId] ?? "",
          evidence: evidence[testCaseId] ?? "",
        }),
      });
      toast.notify("success", t("workspace.notesSaved"));
      await reload();
    } catch (error) {
      const text = error instanceof Error ? err(error.message) : t("errors.failed");
      toast.notify("error", text);
    }
  };

  const uploadCaseMedia = async (testCaseId: string, files: File[]) => {
    try {
      const created: MediaItem[] = [];
      for (const file of files) {
        created.push(
          await uploadFile<MediaItem>("/attachments", file, {
            ownerKind: "TEST_CASE",
            ownerId: testCaseId,
          }),
        );
      }
      setMedia((prev) => ({
        ...prev,
        [testCaseId]: [...(prev[testCaseId] ?? []), ...created],
      }));
    } catch (error) {
      const text = error instanceof Error ? err(error.message) : t("errors.failed");
      toast.notify("error", text);
    }
  };

  const removeCaseMedia = async (testCaseId: string, attachmentId: string) => {
    const file = media[testCaseId]?.find((item) => item.id === attachmentId);
    if (!window.confirm(t("common.confirmDelete", { name: file?.filename ?? "" }))) return;
    try {
      await api(`/attachments/${attachmentId}`, { method: "DELETE" });
      setMedia((prev) => ({
        ...prev,
        [testCaseId]: (prev[testCaseId] ?? []).filter((item) => item.id !== attachmentId),
      }));
    } catch (error) {
      const text = error instanceof Error ? err(error.message) : t("errors.failed");
      toast.notify("error", text);
    }
  };

  const emptyManual = {
    title: "",
    acceptanceKey: "",
    preconditions: "",
    steps: "",
    expectedResult: "",
    priority: "MEDIUM",
  };

  const saveManual = async () => {
    if (!issue) return;
    setMessage(null);
    try {
      await api("/test-cases", {
        method: "POST",
        body: JSON.stringify({
          jiraIssueId: issue.id,
          title: manual.title,
          acceptanceKey: manual.acceptanceKey || undefined,
          preconditions: manual.preconditions
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          steps: manual.steps
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          expectedResult: manual.expectedResult,
          priority: manual.priority,
        }),
      });
      setManual(emptyManual);
      setManualOpen(false);
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("workspace.generationFailed"));
    }
  };

  // The model's translation of the issue into the workspace language, unless the user wants the original.
  const translated = deep?.translation && !showOriginal ? deep.translation : null;
  const shownTitle = translated?.title || issue?.title || "";
  const shownDescription = translated?.description || issue?.description || "";
  const shownCriterion = (index: number, text: string) => translated?.acceptanceCriteria[index] || text;

  if (!issue) {
    return (
      <p className="text-sm text-muted-foreground">
        {message ??
          (issueKey
            ? t("workspace.loading", { key: issueKey })
            : t("workspace.missingKey"))}
      </p>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <ProgressBanner
        active={progress.active}
        value={progress.percent}
        label={progress.label || t("common.processing")}
        error={progress.error}
        success={progress.success}
      />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="dir-ltr inline-block font-mono text-xs text-primary">
            {issue.key}
          </div>
          <h1 className="break-words text-lg font-semibold">{shownTitle}</h1>
          {deep?.translation ? (
            <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setShowOriginal((current) => !current)}>
              {showOriginal ? t("deepAnalysis.showTranslation") : t("deepAnalysis.showOriginal")}
            </button>
          ) : null}
          {trace ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {t("workspace.coverageLine", {
                pct: p(trace.coverage.requirementCoverage),
                covered: n(trace.coverage.acceptanceCovered),
                total: n(trace.coverage.acceptanceTotal),
              })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border pb-2">
        {TAB_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`shrink-0 rounded px-2.5 py-1 text-xs transition-colors ${
              tab === id
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {t(TAB_LABEL_KEYS[id])}
          </button>
        ))}
      </div>

      {message ? <p className="text-xs text-muted-foreground">{err(message)}</p> : null}

      {tab === "overview" && (
        <div className="space-y-3">
          <BidiText text={shownDescription} className="block whitespace-pre-line text-sm text-muted-foreground" />
          <ReleaseGate issue={issue} />
          <div className="space-y-1">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("workspace.acHeading")}
            </h2>
            {issue.acceptanceCriteria.map((ac, index) => (
              <div
                key={ac.id}
                className="rounded border border-border px-2 py-1.5 text-sm"
              >
                <span className="dir-ltr inline-block font-mono text-xs text-primary">
                  {ac.key}
                </span>{" "}
                {shownCriterion(index, ac.text)}
                <AcOrigin origin={ac.origin} />
              </div>
            ))}
          </div>
          <DeepAnalysisPanel
            issueId={issue.id}
            hasAcceptanceCriteria={issue.acceptanceCriteria.some((ac) => ac.origin !== "derived")}
            busy={busy}
            onStatus={setDeep}
            onFallback={(target) => generate("all", undefined, undefined, target)}
            onFinished={async () => {
              await reload();
              toast.notify("success", t("deepAnalysis.done"));
            }}
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("workspace.generationNote")}
          </p>
        </div>
      )}

      {tab === "requirements" &&
        (issue.requirementAnalysis ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <Button variant="outline" disabled={busy} onClick={() => generate("requirements")}>
                {busy ? t("common.processing") : t("workspace.regenerateInLanguage")}
              </Button>
              <span className="text-[11px] text-muted-foreground">{t("workspace.regenerateHint")}</span>
            </div>
            <List
              title={t("workspace.summary")}
              items={[issue.requirementAnalysis.summary]}
            />
            <List
              title={t("workspace.gaps")}
              items={issue.requirementAnalysis.gaps}
            />
            <List
              title={t("workspace.ambiguities")}
              items={issue.requirementAnalysis.ambiguities}
            />
            <List
              title={t("workspace.missingScenarios")}
              items={issue.requirementAnalysis.missingScenarios}
            />
            {(["product", "developer", "business"] as const).map((category) => {
              const analysis = issue.requirementAnalysis!;
              const plain =
                category === "product"
                  ? analysis.questionsProduct
                  : category === "developer"
                    ? analysis.questionsDeveloper
                    : analysis.questionsBusiness;
              const details = analysis.questionDetails?.filter((item) => item.category === category);
              const items = details?.length
                ? details
                : plain.map((question) => ({ question, reason: "" }));
              if (items.length === 0) return null;
              return (
                <Card key={category}>
                  <CardHeader>
                    <CardTitle>{t(`workspace.questions${category[0]!.toUpperCase()}${category.slice(1)}`)}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {items.map((item) => (
                      <div key={item.question}>
                        <BidiText text={item.question} className="block text-sm" />
                        {item.reason ? (
                          <BidiText
                            text={t("workspace.questionReason", { reason: item.reason })}
                            className="block text-[11px] text-muted-foreground"
                          />
                        ) : null}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
            })}
            {[
              issue.requirementAnalysis.questionsProduct,
              issue.requirementAnalysis.questionsDeveloper,
              issue.requirementAnalysis.questionsBusiness,
            ].every((list) => list.length === 0) ? (
              <Card>
                <CardContent className="p-3 text-sm text-muted-foreground">
                  {t("workspace.noQuestions")}
                </CardContent>
              </Card>
            ) : null}
            {issue.requirementAnalysis.suggestedCriteria?.length ? (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle>{t("workspace.suggestedCriteria")}</CardTitle>
                  <p className="text-[11px] text-muted-foreground">{t("workspace.suggestedCriteriaHint")}</p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {issue.requirementAnalysis.suggestedCriteria.map((item) => (
                    <div key={item.text} className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {item.confidence ? (
                          <span className="rounded border border-primary/40 px-1 font-mono text-[10px] text-primary dir-ltr">{item.source}</span>
                        ) : null}
                        <BidiText text={item.text} className="text-sm" />
                        {item.confidence ? (
                          <span
                            className={`rounded border px-1 text-[10px] ${
                              item.confidence === "HIGH"
                                ? "border-success/40 text-success"
                                : item.confidence === "MEDIUM"
                                  ? "border-primary/40 text-primary"
                                  : "border-warning/50 text-warning"
                            }`}
                          >
                            {t(`deepAnalysis.confidence.${item.confidence}`)}
                          </span>
                        ) : null}
                        {item.needsConfirmation ? (
                          <span className="rounded border border-warning/50 px-1 text-[10px] text-warning">{t("deepAnalysis.needsConfirmation")}</span>
                        ) : null}
                      </div>
                      {item.reason ? (
                        <BidiText
                          text={t("workspace.questionReason", { reason: item.reason })}
                          className="block text-[11px] text-muted-foreground"
                        />
                      ) : null}
                      {item.evidence ? (
                        <BidiText
                          text={t(item.grounded ? "deepAnalysis.evidence" : "deepAnalysis.evidenceMissing", { quote: item.evidence })}
                          className="block text-[11px] text-muted-foreground"
                        />
                      ) : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : (
          <Button disabled={busy} onClick={() => generate("requirements")}>
            {t("workspace.analyzeRequirements")}
          </Button>
        ))}

      {tab === "strategy" &&
        (issue.testStrategy ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <Button variant="outline" disabled={busy} onClick={() => generate("strategy")}>
                {busy ? t("common.processing") : t("workspace.regenerateInLanguage")}
              </Button>
              <span className="text-[11px] text-muted-foreground">{t("workspace.regenerateHint")}</span>
            </div>
            <List
              title={t("workspace.scope")}
              items={[issue.testStrategy.scope]}
            />
            <List
              title={t("workspace.objectives")}
              items={issue.testStrategy.objectives}
            />
            <List
              title={t("workspace.testTypes")}
              items={issue.testStrategy.testTypes}
            />
            <List
              title={t("workspace.environments")}
              items={issue.testStrategy.environments}
            />
            <List
              title={t("workspace.dependencies")}
              items={issue.testStrategy.dependencies}
            />
            <List
              title={t("workspace.assumptions")}
              items={issue.testStrategy.assumptions}
            />
          </div>
        ) : (
          <Button disabled={busy} onClick={() => generate("strategy")}>
            {t("workspace.generateStrategy")}
          </Button>
        ))}

      {tab === "testCases" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => generate("test-cases", "all")}>
              {busy ? t("common.processing") : t("workspace.generateTestCases")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => generate("test-cases", "missing")}
            >
              {t("workspace.generateMissing")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => generate("test-cases", "drafts")}
            >
              {t("workspace.generateDrafts")}
            </Button>
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              value={acKey}
              onChange={(event) => setAcKey(event.target.value)}
            >
              <option value="">{t("workspace.selectAc")}</option>
              {issue?.acceptanceCriteria.map((item) => (
                <option key={item.id} value={item.key}>
                  {item.key}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              disabled={busy || !acKey}
              title={!acKey ? t("workspace.generateSelectedHint") : undefined}
              onClick={() => generate("test-cases", "all", [acKey])}
            >
              {t("workspace.generateSelected")}
            </Button>
            <Button
              variant="outline"
              disabled={syncing || !issue?.testCases.length}
              title={!issue?.testCases.length ? t("workspace.syncNeedsCases") : t("workspace.syncHint")}
              onClick={() => void syncCases(issue?.testCases.map((item) => item.id) ?? [])}
            >
              {syncing ? t("workspace.syncing") : t("workspace.syncToJira")}
            </Button>
            <Button
              variant="outline"
              disabled={syncing || selectedCases.length === 0}
              title={selectedCases.length === 0 ? t("workspace.syncNeedsSelection") : t("workspace.syncHint")}
              onClick={() => void syncCases(selectedCases)}
            >
              {t("workspace.syncSelected", { count: n(selectedCases.length) })}
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={
                  Boolean(issue?.testCases.length) &&
                  selectedCases.length === issue?.testCases.length
                }
                onChange={(event) =>
                  setSelectedCases(
                    event.target.checked ? (issue?.testCases.map((item) => item.id) ?? []) : [],
                  )
                }
              />
              {t("workspace.selectAll")}
            </label>
            <Button variant="outline" onClick={() => setManualOpen(true)}>
              {t("workspace.manualCase")}
            </Button>
          </div>
          {issue?.testCases.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
          ) : null}
          {manualOpen ? (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="manual-case-title"
                className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-md border border-border bg-background p-4"
              >
                <h2 id="manual-case-title" className="text-sm font-medium">
                  {t("workspace.manualCase")}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">{t("workspace.manualCaseHint")}</p>
                <div className="mt-3 space-y-2">
                  <input
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={manual.title}
                    placeholder={t("common.name")}
                    onChange={(event) => setManual((prev) => ({ ...prev, title: event.target.value }))}
                  />
                  <div className="grid gap-2 md:grid-cols-2">
                    <select
                      className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                      value={manual.acceptanceKey}
                      onChange={(event) =>
                        setManual((prev) => ({ ...prev, acceptanceKey: event.target.value }))
                      }
                    >
                      <option value="">{t("workspace.criterion")}</option>
                      {issue?.acceptanceCriteria.map((criterion) => (
                        <option key={criterion.id} value={criterion.key}>
                          {criterion.key}
                        </option>
                      ))}
                    </select>
                    <select
                      className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                      value={manual.priority}
                      onChange={(event) => setManual((prev) => ({ ...prev, priority: event.target.value }))}
                    >
                      {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((priority) => (
                        <option key={priority} value={priority}>
                          {label("level", priority)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={manual.preconditions}
                    placeholder={t("workspace.manualPreconditionsHint")}
                    onChange={(event) =>
                      setManual((prev) => ({ ...prev, preconditions: event.target.value }))
                    }
                  />
                  <textarea
                    className="min-h-20 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={manual.steps}
                    placeholder={t("workspace.manualStepsHint")}
                    onChange={(event) => setManual((prev) => ({ ...prev, steps: event.target.value }))}
                  />
                  <textarea
                    className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={manual.expectedResult}
                    placeholder={t("common.expected")}
                    onChange={(event) =>
                      setManual((prev) => ({ ...prev, expectedResult: event.target.value }))
                    }
                  />
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => setManualOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={busy || !manual.title.trim() || !manual.steps.trim() || !manual.expectedResult.trim()}
                    onClick={() => void saveManual()}
                  >
                    {t("workspace.saveCase")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {groupCases(issue).map((group) => (
            <div key={group.key} className="space-y-2">
              <h2 className="text-xs font-medium text-muted-foreground">
                {group.key === "unlinked" ? (
                  t("workspace.unlinkedGroup")
                ) : (
                  <>
                    <span className="dir-ltr inline-block font-mono text-primary">
                      {group.key}
                    </span>{" "}
                    {group.text}
                  </>
                )}
              </h2>
              {group.cases.map((tc) => (
            <Card key={tc.id}>
              <CardContent className="space-y-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-start gap-2 text-sm font-medium leading-6">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedCases.includes(tc.id)}
                    onChange={(event) =>
                      setSelectedCases((current) =>
                        event.target.checked
                          ? [...current, tc.id]
                          : current.filter((id) => id !== tc.id),
                      )
                    }
                  />
                  <span className="break-words">
                    <BidiText text={tc.title} />
                  </span>
                </label>
                  <StatusBadge
                    status={tc.runs[0]?.status ?? "NOT_RUN"}
                    label={statusLabel(tc.runs[0]?.status ?? "NOT_RUN")}
                  />
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  <span className="dir-ltr inline-block">{tc.id}</span>
                  {" · "}
                  {label("level", tc.priority)} · {label("level", tc.type)}
                  {" · "}
                  {t(`workspace.syncStatus.${tc.jiraSyncStatus || "NOT_SYNCED"}`)}
                  {tc.designStatus
                    ? ` · ${t("workspace.designStatus")}: ${label("workspace.designStatuses", tc.designStatus)}`
                    : ""}
                  {tc.technique ? ` · ${tc.technique}` : ""}
                  {tc.automationSuitability
                    ? ` · ${t("workspace.automationSuitability")}: ${label("level", tc.automationSuitability)}`
                    : ""}
                  {tc.acceptanceLinks?.length
                    ? ` · ${tc.acceptanceLinks.map((l) => l.acceptanceCriterion.key).join(", ")}`
                    : ""}
                </div>
                {tc.preconditions?.length ? (
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("common.preconditions")}
                    </div>
                    {tc.preconditions.map((item) => (
                      <BidiText key={item} text={item} className="block text-xs leading-5" />
                    ))}
                  </div>
                ) : null}
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t("common.steps")}
                  </div>
                  {(Array.isArray(tc.steps) ? tc.steps : []).map((step, index) => (
                    <div
                      key={`${tc.id}-${index}`}
                      className="rounded border border-border px-2 py-1.5 text-xs leading-5"
                    >
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {n(index + 1)}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t("workspace.action")}
                      </div>
                      <BidiText
                        text={typeof step === "string" ? step : ""}
                        className="block"
                      />
                      {tc.stepExpectations?.[index] ? (
                        <>
                          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t("workspace.stepExpected")}
                          </div>
                          <BidiText
                            text={tc.stepExpectations[index]}
                            className="block text-muted-foreground"
                          />
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
                {tc.testData?.length ? (
                  <p dir="auto" className="text-xs leading-5">
                    <span className="text-muted-foreground">{t("workspace.testData")}:</span>{" "}
                    {tc.testData.join(" · ")}
                  </p>
                ) : null}
                {tc.description ? (
                  <BidiText text={`${t("workspace.objective")}: ${tc.description}`} className="block text-xs leading-5" />
                ) : null}
                <BidiText
                  text={`${t("workspace.finalExpected")}: ${tc.expectedResult}`}
                  className="block text-xs leading-5"
                />
                {tc.gapRefs?.length ? (
                  <p className="text-xs leading-5 text-warning">
                    {t("workspace.requirementGaps")}: {tc.gapRefs.join(", ")}
                  </p>
                ) : null}
                {tc.jiraSyncError ? (
                  <p className="text-xs text-destructive">{err(tc.jiraSyncError)}</p>
                ) : null}
                <div className="grid gap-2 md:grid-cols-2">
                  <textarea
                    className="min-h-16 rounded border border-border bg-background px-2 py-1 text-xs"
                    placeholder={t("common.notes")}
                    value={notes[tc.id] ?? ""}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [tc.id]: e.target.value }))
                    }
                  />
                  <textarea
                    className="min-h-16 rounded border border-border bg-background px-2 py-1 text-xs"
                    placeholder={t("common.evidence")}
                    value={evidence[tc.id] ?? ""}
                    onChange={(e) =>
                      setEvidence((prev) => ({
                        ...prev,
                        [tc.id]: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveNotes(tc.id)}>
                    {t("workspace.saveNotes")}
                  </Button>
                </div>
                <MediaGallery
                  items={media[tc.id] ?? []}
                  removeLabel={t("common.delete")}
                  onRemove={(attachmentId) => void removeCaseMedia(tc.id, attachmentId)}
                />
                <MediaPicker
                  label={t("common.media")}
                  hint={t("common.mediaHint")}
                  disabled={busy}
                  onFiles={(files) => void uploadCaseMedia(tc.id, files)}
                />
                <div className="flex flex-wrap gap-2">
                  {STATUSES.map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant="outline"
                      className="min-w-[4.75rem] shrink-0"
                      disabled={busy}
                      onClick={() => runCase(tc.id, s)}
                    >
                      {statusLabel(s)}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === "edgeCases" && (
        <div className="space-y-2">
          <Button disabled={busy} onClick={() => generate("edge-cases")}>
            {t("workspace.generateEdgeCases")}
          </Button>
          {issue.edgeCases.length === 0 ? (
            <EdgeCasesEmpty
              issueId={issue.id}
              generated={Boolean(issue.requirementAnalysis) || issue.testCases.length > 0}
              refreshKey={`${issue.testCases.length}:${deep?.runs?.[locale]?.createdAt ?? ""}`}
            />
          ) : null}
          {issue.edgeCases.map((e) => (
            <Card key={e.id}>
              <CardContent className="p-3">
                <BidiText text={e.title} className="block text-sm font-medium" />
                <BidiText
                  text={e.description}
                  className="mt-2 block whitespace-pre-wrap text-xs leading-5 text-muted-foreground"
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {tab === "risks" && (
        <div className="space-y-3">
          <Button disabled={busy} onClick={() => generate("risks")}>
            {t("workspace.generateRisks")}
          </Button>
          <p className="text-[11px] leading-snug text-muted-foreground">{t("workspace.riskNote")}</p>
          <ReleaseGate issue={issue} />
          {issue.risks.filter((risk) => !risk.releaseBlocking).length > 0 ? (
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("workspace.otherRisks")}
            </h2>
          ) : null}
          {issue.risks
            .filter((risk) => !risk.releaseBlocking)
            .map((r) => (
            <Card key={r.id}>
              <CardContent className="p-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge>{label("level", r.impact)}</Badge>
                  <Badge>{label("level", r.likelihood)}</Badge>
                </div>
                <BidiText text={r.description} className="mt-2 block" />
                <BidiText text={r.mitigation} className="mt-1 block text-xs text-muted-foreground" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {tab === "automation" && (
        <div className="space-y-2">
          <Button disabled={busy} onClick={() => generate("automation")}>
            {t("workspace.suggestAutomation")}
          </Button>
          <p className="text-[11px] leading-snug text-muted-foreground">{t("workspace.automationNote")}</p>
          {issue.automationCandidates.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-3 text-sm">
                <div className="flex gap-2">
                  <Badge>{label("level", c.recommendedLevel)}</Badge>
                  <Badge>{label("level", c.apiUiRecommendation)}</Badge>
                </div>
                <BidiText text={c.reasoning} className="mt-2 block text-muted-foreground" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {tab === "traceability" && (
        <div className="space-y-3">
          <Card>
            <CardContent className="flex items-center justify-between p-3 text-sm">
              <span className="text-muted-foreground">
                {t("workspace.requirementCoverage")}
              </span>
              <span className="font-mono text-primary">
                {p(trace?.coverage.requirementCoverage)}
                {trace ? (
                  <span className="dir-ltr ms-2 inline-block text-[11px] text-muted-foreground">
                    {n(trace.coverage.acceptanceCovered)} / {n(trace.coverage.acceptanceTotal)}
                  </span>
                ) : null}
              </span>
            </CardContent>
          </Card>
          {(trace?.nodes ?? []).map((ac) => (
            <Card key={ac.id}>
              <CardHeader>
                <CardTitle>
                  <span className="dir-ltr inline-block font-mono text-primary">
                    {ac.key}
                  </span>{" "}
                  {ac.text}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {ac.testCases.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("workspace.noLinkedCases")}
                  </p>
                ) : (
                  ac.testCases.map((tc) => (
                    <div
                      key={tc.id}
                      className="rounded border border-border px-2.5 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>{tc.title}</span>
                        <StatusBadge
                          status={tc.latestStatus}
                          label={statusLabel(tc.latestStatus)}
                        />
                      </div>
                      {tc.bugs.map((b) => (
                        <div
                          key={b.id}
                          className="mt-1 font-mono text-[11px] text-destructive"
                        >
                          → {b.title} [{label("level", b.severity)}]
                        </div>
                      ))}
                      {tc.automationCandidates.map((a) => (
                        <div
                          key={a.id}
                          className="mt-1 font-mono text-[11px] text-muted-foreground"
                        >
                          →{" "}
                          {t("workspace.automationCandidate", {
                            kind: label("level", a.apiUiRecommendation),
                          })}
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
                  <div key={tc.id} className="flex justify-between text-sm">
                    <span>{tc.title}</span>
                    <StatusBadge
                      status={tc.latestStatus}
                      label={statusLabel(tc.latestStatus)}
                    />
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
                {trace?.failedWithoutBug?.map((item) => (
                  <BidiText key={item.id} text={item.title} className="block text-sm" />
                ))}
              </CardContent>
            </Card>
          ) : null}
          {(trace?.gaps?.length ?? 0) > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("workspace.requirementGaps")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {trace?.gaps?.map((gap) => (
                  <BidiText
                    key={gap.id}
                    text={`${gap.id}: ${gap.description}`}
                    className="block text-sm"
                  />
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

      {tab === "runs" && (
        <div className="space-y-2">
          {issue.testCases.flatMap((tc) =>
            tc.runs.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between rounded border border-border px-2.5 py-2 text-sm"
              >
                <div>
                  <BidiText text={tc.title} className="block" />
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {d(run.executedAt)}
                    {run.notes ? ` · ${run.notes}` : ""}
                  </div>
                </div>
                <StatusBadge
                  status={run.status}
                  label={statusLabel(run.status)}
                />
              </div>
            )),
          )}
          {issue.testCases.every((tc) => tc.runs.length === 0) ? (
            <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
          ) : null}
        </div>
      )}

      {tab === "bugs" && (
        <div className="space-y-2">
          {issue.bugs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("workspace.noBugsYet")}
            </p>
          ) : (
            issue.bugs.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between rounded border border-border px-2.5 py-2 text-sm"
              >
                <BidiText text={b.title} />
                <Badge>{label("level", b.severity)}</Badge>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function groupCases(issue: Issue) {
  const rank = (tags: string[] | undefined) =>
    tags?.includes("negative") ? 1 : tags?.includes("boundary") ? 2 : 0;
  const groups = issue.acceptanceCriteria.map((ac) => ({
    key: ac.key,
    text: ac.text,
    cases: issue.testCases
      .filter((testCase) =>
        testCase.acceptanceLinks.some(
          (link) => link.acceptanceCriterion.key === ac.key,
        ),
      )
      .sort((left, right) => rank(left.tags) - rank(right.tags)),
  }));
  const linked = new Set(
    groups.flatMap((group) => group.cases.map((testCase) => testCase.id)),
  );
  const unlinked = issue.testCases.filter((testCase) => !linked.has(testCase.id));
  const visible = groups.filter((group) => group.cases.length > 0);
  if (unlinked.length > 0) {
    visible.push({ key: "unlinked", text: "", cases: unlinked });
  }
  return visible;
}

function AcOrigin({ origin }: { origin?: string }) {
  const { t } = useI18n();
  if (origin !== "derived" && origin !== "cleaned") return null;
  return (
    <Badge className="ms-2">
      {origin === "derived" ? t("workspace.acDerived") : t("workspace.acCleaned")}
    </Badge>
  );
}

function ReleaseGate({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  const blocking = issue.risks.filter((risk) => risk.releaseBlocking);
  return (
    <Card className={blocking.length > 0 ? "border-destructive/50" : undefined}>
      <CardHeader>
        <CardTitle>{t("workspace.releaseGate")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {blocking.length > 0
            ? t("workspace.releaseGateBody")
            : issue.risks.length > 0
              ? t("workspace.releaseGateNone")
              : t("workspace.releaseGateEmpty")}
        </p>
        {blocking.map((risk) => (
          <div
            key={risk.id}
            className="rounded border border-border px-2 py-1.5 text-sm"
          >
            <div className="mb-1 flex flex-wrap gap-1">
              <Badge className="border-destructive/40 bg-destructive/10 text-destructive">
                {t("workspace.blocksProduction")}
              </Badge>
              {(risk.acceptanceKeys ?? []).map((key) => (
                <span
                  key={key}
                  className="dir-ltr inline-flex items-center rounded border border-border px-1.5 font-mono text-[10px]"
                >
                  {key}
                </span>
              ))}
            </div>
            <p>{risk.description}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  // An empty section is hidden rather than padded with filler text.
  if (items.filter(Boolean).length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {items.map((item) => (
          <BidiText key={item} text={item} className="block text-sm text-muted-foreground" />
        ))}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone =
    status === "PASSED"
      ? "border-success/40 bg-success/10 text-success"
      : status === "FAILED"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : status === "BLOCKED"
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-border bg-secondary text-muted-foreground";
  return <Badge className={tone}>{label}</Badge>;
}
