"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseCurl } from "@/lib/curl/parse-curl";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressBar, ProgressBanner } from "@/components/ui/progress";
import { StepRunFacts, VariableFacts } from "@/components/scenarios/run-facts";
import { JsonTree } from "@/components/scenarios/json-tree";
import { FlowTrace } from "@/components/scenarios/flow-trace";
import { ScenarioFlow } from "@/components/scenarios/scenario-flow";
import { SmartResponse } from "@/components/scenarios/smart-response";
import {
  DatabaseStepForm,
  EMPTY_DATABASE_STEP,
  databaseStepConfig,
  databaseStepFromConfig,
  databaseStepProblem,
  type ConnectorChoice,
  type DatabaseStepValue,
} from "@/components/scenarios/database-step-form";
import { useI18n } from "@/lib/i18n";

type Step = {
  id: string;
  name: string;
  type: string;
  orderIndex: number;
  enabled: boolean;
  config: Record<string, unknown>;
};

type StepRun = {
  id: string;
  name: string;
  type: string;
  status: string;
  durationMs?: number;
  error?: string | null;
  resolvedInput?: unknown;
  output?: unknown;
  extractedVars?: unknown;
};

type ScenarioRun = {
  id: string;
  status: string;
  durationMs?: number | null;
  error?: string | null;
  variablesJson?: Record<string, string> | null;
  stepRuns: StepRun[];
  startedAt?: string | null;
  finishedAt?: string | null;
};

type Scenario = {
  id: string;
  name: string;
  stopOnFailure: boolean;
  environmentId?: string | null;
  steps: Step[];
  runs: ScenarioRun[];
};

type Env = { id: string; name: string };

type FlowDependency = {
  id: string;
  producerStepId: string;
  producerName: string;
  consumerStepId: string;
  consumerName: string;
  sourcePath: string;
  variable: string;
  location: "url" | "header" | "query" | "body";
  locationDetail: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  masked: boolean;
};

type FlowAnalysis = {
  dependencies: FlowDependency[];
  issues: Array<{ stepId: string; severity: string; code: string; detail: string }>;
  health: {
    ready: boolean;
    http: number;
    dependencies: number;
    extracts: number;
    assertions: number;
    errors: number;
    warnings: number;
  };
  responses: Array<{
    stepId: string;
    analysis: {
      status: number | null;
      durationMs: number | null;
      sizeBytes: number | null;
      contentType: string | null;
      importantFields: Array<{ path: string; label: string; preview: string; masked: boolean }>;
      candidateOutputs: Array<{ path: string; name: string; preview: string }>;
      arraySummaries: Array<{ path: string; length: number; fields: string[]; previewCount: number }>;
      errorInformation: { message: string; code: string | null } | null;
      warnings: string[];
    };
  }>;
};

const STEP_TYPES = [
  "HTTP_REQUEST",
  "ASSERTION",
  "EXTRACT_VARIABLE",
  "SET_VARIABLE",
  "DELAY",
  "CONDITION",
  "DATABASE_ACTION",
] as const;

const TEMPLATES: Record<(typeof STEP_TYPES)[number], { name: string; config: unknown }> = {
  HTTP_REQUEST: {
    name: "HTTP Request",
    config: {
      method: "GET",
      url: "{{base_url}}/get",
      headers: { Authorization: "Bearer {{token}}" },
      query: {},
      body: {},
      timeoutMs: 15000,
    },
  },
  ASSERTION: {
    name: "Assert status",
    config: { kind: "status_code", expected: 200 },
  },
  EXTRACT_VARIABLE: {
    name: "Extract variable",
    config: { path: "body.data.orderId", variable: "order_id" },
  },
  SET_VARIABLE: {
    name: "Set variable",
    config: { variable: "order_id", value: "ORD-{{suffix}}" },
  },
  DELAY: {
    name: "Delay",
    config: { ms: 1500 },
  },
  CONDITION: {
    name: "Condition",
    config: { left: "{{status}}", op: "equals", right: "CREATED" },
  },
  DATABASE_ACTION: {
    name: "Database action",
    config: {
      connectorId: "",
      operation: "SELECT",
      query: "SELECT * FROM users WHERE id = {{userId}}",
      inputMapping: { userId: "userId" },
      outputMapping: { user_name: "name" },
    },
  },
};

const TERMINAL = new Set(["PASSED", "FAILED", "CANCELLED"]);

function statusTone(status: string) {
  if (status === "PASSED") return "text-success";
  if (status === "FAILED") return "text-destructive";
  if (status === "CANCELLED") return "text-warning";
  if (status === "RUNNING") return "text-primary";
  return "text-muted-foreground";
}

export default function ScenariosPage() {
  const { t, n, d, err, label } = useI18n();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [envs, setEnvs] = useState<Env[]>([]);
  const [connectors, setConnectors] = useState<ConnectorChoice[]>([]);
  const [dbStep, setDbStep] = useState<DatabaseStepValue>(EMPTY_DATABASE_STEP);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [stepType, setStepType] =
    useState<(typeof STEP_TYPES)[number] | "">("");
  const [stepName, setStepName] = useState("");
  const [configText, setConfigText] = useState("");
  const [curlMode, setCurlMode] = useState(false);
  const [curlText, setCurlText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [analysis, setAnalysis] = useState<FlowAnalysis | null>(null);
  const [hiddenDeps, setHiddenDeps] = useState<string[]>([]);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<ScenarioRun | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const statusLabel = (status: string) => label("status", status);
  const selected = scenarios.find((s) => s.id === selectedId) ?? null;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const reload = async () => {
    const [list, environmentList, connectorList] = await Promise.all([
      api<Scenario[]>("/scenarios"),
      api<Env[]>("/environments"),
      api<ConnectorChoice[]>("/database-connectors"),
    ]);
    setScenarios(list);
    setEnvs(environmentList);
    setConnectors(connectorList);
    setSelectedId((current) => current ?? list[0]?.id ?? null);
  };

  const refreshSelected = async (id: string) => {
    const detail = await api<Scenario>(`/scenarios/${id}`);
    setScenarios((prev) => {
      const exists = prev.some((s) => s.id === id);
      if (!exists) return [...prev, detail];
      return prev.map((s) => (s.id === id ? detail : s));
    });
    try {
      setAnalysis(await api<FlowAnalysis>(`/scenarios/${id}/analyze-flow`, { method: "POST", body: "{}" }));
    } catch {
      setAnalysis(null);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, environmentList, connectorList] = await Promise.all([
          api<Scenario[]>("/scenarios"),
          api<Env[]>("/environments"),
          api<ConnectorChoice[]>("/database-connectors"),
        ]);
        if (!alive) return;
        setScenarios(list);
        setEnvs(environmentList);
        setConnectors(connectorList);
        setSelectedId((current) => current ?? list[0]?.id ?? null);
      } catch (e) {
        if (alive) setMessage(e instanceof Error ? e.message : "Load failed");
      }
    })();
    return () => {
      alive = false;
      stopPolling();
    };
  }, [stopPolling]);

  const applyTemplate = (type: (typeof STEP_TYPES)[number] | "") => {
    if (!type) {
      setStepType("");
      setStepName("");
      setConfigText("");
      setCurlMode(false);
      setCurlText("");
      setEditingStepId(null);
      setDbStep(EMPTY_DATABASE_STEP);
      return;
    }
    const template = TEMPLATES[type];
    setStepType(type);
    // Keep fields empty; show template only as placeholders/hints.
    setStepName("");
    setConfigText("");
    setCurlMode(false);
    setCurlText("");
    setEditingStepId(null);
    setDbStep(EMPTY_DATABASE_STEP);
    return template;
  };

  const configPlaceholder = stepType
    ? JSON.stringify(TEMPLATES[stepType].config, null, 2)
    : '{\n  "key": "value"\n}';
  const stepNamePlaceholder = stepType
    ? label("stepType", stepType)
    : t("scenarios.stepNameHint");
  const curlParsed =
    curlMode && stepType === "HTTP_REQUEST" && curlText.trim()
      ? parseCurl(curlText)
      : null;
  const selectedConnector = connectors.find((item) => item.id === dbStep.connectorId);
  const databaseProblem = databaseStepProblem(dbStep, selectedConnector?.type);

  const startLivePoll = (runId: string, scenarioId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const run = await api<ScenarioRun>(`/scenarios/runs/${runId}`);
        setLiveRun(run);
        if (TERMINAL.has(run.status)) {
          stopPolling();
          setBusy(false);
          setMessage(`Run finished: ${run.status}`);
          await refreshSelected(scenarioId);
        }
      } catch (e) {
        stopPolling();
        setBusy(false);
        setMessage(e instanceof Error ? e.message : "Poll failed");
      }
    }, 400);
  };

  const moveStep = async (stepId: string, direction: -1 | 1) => {
    if (!selected) return;
    const ordered = [...selected.steps].sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );
    const index = ordered.findIndex((s) => s.id === stepId);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    await api(`/scenarios/${selected.id}/reorder`, {
      method: "POST",
      body: JSON.stringify({ stepIds: next.map((s) => s.id) }),
    });
    await refreshSelected(selected.id);
  };

  return (
    <div className="mx-auto grid min-w-0 max-w-6xl grid-cols-1 gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
      <Card className="h-fit min-w-0">
        <CardHeader>
          <CardTitle>{t("scenarios.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <input
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("common.name")}
          />
          <Button
            className="w-full"
            disabled={!name.trim()}
            onClick={async () => {
              const created = await api<Scenario>("/scenarios", {
                method: "POST",
                body: JSON.stringify({ name }),
              });
              setName("");
              await reload();
              setSelectedId(created.id);
              await refreshSelected(created.id);
            }}
          >
            {t("scenarios.create")}
          </Button>
          <div className="flex gap-1 overflow-x-auto pt-2 xl:block xl:space-y-1 xl:overflow-visible">
            {scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setSelectedId(s.id);
                  void refreshSelected(s.id);
                }}
                className={`shrink-0 rounded px-2 py-1.5 text-start text-sm xl:block xl:w-full ${
                  selectedId === s.id
                    ? "bg-primary/15 text-primary"
                    : "hover:bg-accent"
                }`}
              >
                <span className="block truncate">{s.name}</span>
                <span className="block font-mono text-[10px] text-muted-foreground">
                  {t("scenarios.stepsCount", { count: n(s.steps.length) })}
                  {s.runs[0]?.status ? ` · ${s.runs[0].status}` : ""}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-3">
        <p className="text-xs text-muted-foreground">{t("scenarios.subtitle")}</p>
        {message ? <p className="text-xs text-destructive">{err(message)}</p> : null}
        {liveRun?.status === "RUNNING" && selected ? (
          <ProgressBanner
            active
            value={Math.max(
              5,
              Math.round(
                ((liveRun.stepRuns?.length ?? 0) /
                  Math.max(selected.steps.length, 1)) *
                  100,
              ),
            )}
            label={t("scenarios.liveExecution")}
          />
        ) : null}
        {!selected ? (
          <p className="text-sm text-muted-foreground">
            {t("scenarios.selectOrCreate")}
          </p>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 basis-full break-words text-lg font-semibold sm:basis-auto">{selected.name}</h1>
              <select
                className="h-8 w-full min-w-0 basis-full rounded-md border border-border bg-background px-2 text-sm sm:w-auto sm:basis-auto"
                value={selected.environmentId ?? ""}
                onChange={async (e) => {
                  await api(`/scenarios/${selected.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      environmentId: e.target.value || null,
                    }),
                  });
                  await refreshSelected(selected.id);
                }}
              >
                <option value="">{t("scenarios.noEnvironment")}</option>
                {envs.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={selected.stopOnFailure}
                  onChange={async (e) => {
                    await api(`/scenarios/${selected.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ stopOnFailure: e.target.checked }),
                    });
                    await refreshSelected(selected.id);
                  }}
                />
                {t("scenarios.stopOnFailure")}
              </label>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setMessage(null);
                  try {
                    const run = await api<ScenarioRun>(
                      `/scenarios/${selected.id}/run`,
                      { method: "POST", body: "{}" },
                    );
                    setLiveRun(run);
                    setExpandedRunId(run.id);
                    startLivePoll(run.id, selected.id);
                  } catch (e) {
                    setBusy(false);
                    setMessage(e instanceof Error ? e.message : "Run failed");
                  }
                }}
              >
                {t("common.run")}
              </Button>
              {liveRun && liveRun.status === "RUNNING" ? (
                <Button
                  variant="destructive"
                  onClick={async () => {
                    await api(`/scenarios/runs/${liveRun.id}/cancel`, {
                      method: "POST",
                      body: "{}",
                    });
                    setMessage(t("common.cancelRequested"));
                  }}
                >
                  {t("scenarios.cancelRun")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={async () => {
                  await api(`/scenarios/${selected.id}/duplicate`, {
                    method: "POST",
                    body: "{}",
                  });
                  await reload();
                }}
              >
                {t("common.duplicate")}
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  if (!window.confirm(t("common.confirmDelete", { name: selected.name }))) return;
                  await api(`/scenarios/${selected.id}`, { method: "DELETE" });
                  setSelectedId(null);
                  await reload();
                }}
              >
                {t("common.delete")}
              </Button>
            </div>

            {liveRun ? (
              <Card className="border-primary/40">
                <CardHeader className="pb-2">
                  <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    {t("scenarios.liveExecution")}
                    <Badge className={statusTone(liveRun.status)}>
                      {statusLabel(liveRun.status)}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {liveRun.id.slice(0, 8)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <ProgressBar
                    value={
                      selected.steps.length === 0
                        ? 0
                        : Math.round(
                            ((liveRun.stepRuns?.length ?? 0) /
                              selected.steps.length) *
                              100,
                          )
                    }
                    label={t("scenarios.liveExecution")}
                    size="sm"
                  />
                  {(liveRun.stepRuns ?? []).map((sr) => (
                    <div
                      key={sr.id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-1 font-mono text-xs"
                    >
                      <span className={statusTone(sr.status)}>
                        {statusLabel(sr.status)} {sr.name}
                        {sr.error ? ` — ${err(sr.error)}` : ""}
                      </span>
                      <span className="text-muted-foreground">
                        {n(sr.durationMs ?? 0)}ms
                      </span>
                    </div>
                  ))}
                  {liveRun.status === "RUNNING" &&
                  (liveRun.stepRuns?.length ?? 0) === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("common.loading")}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => applyTemplate("HTTP_REQUEST")}>
                {t("scenarios.addStage")}
              </Button>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                {t("scenarios.importCurl")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void refreshSelected(selected.id)}
              >
                {t("scenarios.analyzeFlow")}
              </Button>
            </div>
            {selected.steps.length === 0 && !stepType ? (
              <div className="rounded-md border border-border px-3 py-4">
                <p className="text-sm">{t("scenarios.emptyFlow")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("scenarios.emptyFlowHint")}</p>
              </div>
            ) : null}
            {analysis ? (
              <div className="rounded-md border border-border px-3 py-2 text-xs">
                <div className={analysis.health.ready ? "text-success" : "text-destructive"}>
                  {analysis.health.ready
                    ? t("scenarios.flowReady")
                    : t("scenarios.flowBroken", { count: n(analysis.health.errors) })}
                </div>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground dir-ltr">
                  HTTP {n(analysis.health.http)} · deps {n(analysis.health.dependencies)} · vars {n(analysis.health.extracts)} · assert {n(analysis.health.assertions)}
                </p>
              </div>
            ) : null}
            {analysis?.dependencies
              .filter((item) => !hiddenDeps.includes(item.id))
              .map((item) => (
                <div key={item.id} className="rounded-md border border-border px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {item.producerName} → {item.consumerName}
                    </span>
                    <span className="font-mono text-[10px] dir-ltr">{item.confidence}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] dir-ltr">
                    {item.variable} ← {item.sourcePath} · {item.locationDetail}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          try {
                            const next = await api<FlowAnalysis>(`/scenarios/${selected.id}/dependencies/accept`, {
                              method: "POST",
                              body: JSON.stringify(item),
                            });
                            setAnalysis(next);
                            await refreshSelected(selected.id);
                          } catch (error) {
                            setMessage(error instanceof Error ? error.message : "Request failed");
                          }
                        })();
                      }}
                    >
                      {t("scenarios.accept")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setHiddenDeps((current) => [...current, item.id])}>
                      {t("scenarios.reject")}
                    </Button>
                  </div>
                </div>
              ))}
            {stepType || editingStepId ? (
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>
                  {editingStepId
                    ? t("scenarios.editStep")
                    : t("scenarios.addStep")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm"
                    value={stepName}
                    onChange={(e) => setStepName(e.target.value)}
                    placeholder={stepNamePlaceholder}
                  />
                  <select
                    className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm"
                    value={stepType}
                    onChange={(e) =>
                      applyTemplate(
                        (e.target.value || "") as
                          | (typeof STEP_TYPES)[number]
                          | "",
                      )
                    }
                  >
                    <option value="">{t("scenarios.selectStepType")}</option>
                    {STEP_TYPES.map((typeKey) => (
                      <option key={typeKey} value={typeKey}>
                        {label("stepType", typeKey)}
                      </option>
                    ))}
                  </select>
                  <Button
                    className="justify-self-start sm:col-span-2"
                    disabled={
                      !stepName.trim() ||
                      !stepType ||
                      (stepType === "HTTP_REQUEST" &&
                        curlMode &&
                        curlParsed?.ok !== true) ||
                      (stepType === "DATABASE_ACTION" &&
                        (!dbStep.connectorId || !dbStep.query.trim() || Boolean(databaseProblem)))
                    }
                    onClick={async () => {
                      try {
                        const config =
                          stepType === "DATABASE_ACTION"
                            ? databaseStepConfig(dbStep)
                            : stepType === "HTTP_REQUEST" && curlMode
                            ? (() => {
                                const parsed = parseCurl(curlText);
                                if (!parsed.ok) {
                                  throw new Error(t(`scenarios.curlErrors.${parsed.code}`));
                                }
                                return parsed.config;
                              })()
                            : (JSON.parse(
                                configText.trim() ? configText : configPlaceholder,
                              ) as Record<string, unknown>);
                        if (editingStepId) {
                          await api(`/scenarios/steps/${editingStepId}`, {
                            method: "PATCH",
                            body: JSON.stringify({ name: stepName, config }),
                          });
                          setEditingStepId(null);
                        } else {
                          await api(`/scenarios/${selected.id}/steps`, {
                            method: "POST",
                            body: JSON.stringify({
                              name: stepName,
                              type: stepType,
                              config,
                            }),
                          });
                        }
                        applyTemplate("");
                        await refreshSelected(selected.id);
                        setMessage(null);
                      } catch (e) {
                        setMessage(
                          e instanceof Error ? e.message : "Invalid step JSON",
                        );
                      }
                    }}
                  >
                    {editingStepId
                      ? t("scenarios.saveStep")
                      : t("scenarios.addStep")}
                  </Button>
                </div>
                {stepType === "HTTP_REQUEST" ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="text-xs text-foreground">
                        {t("scenarios.curlToggle")}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {t("scenarios.curlHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={curlMode}
                      aria-label={t("scenarios.curlToggle")}
                      onClick={() => setCurlMode((current) => !current)}
                      className={`relative h-4 w-7 shrink-0 rounded-full border ${
                        curlMode
                          ? "border-primary bg-primary"
                          : "border-border bg-background"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-foreground ${
                          curlMode ? "start-3.5" : "start-0.5"
                        }`}
                      />
                    </button>
                  </div>
                ) : null}
                {stepType === "DATABASE_ACTION" ? (
                  <DatabaseStepForm
                    connectors={connectors}
                    value={dbStep}
                    onChange={setDbStep}
                  />
                ) : (
                <>
                <textarea
                  className="min-h-28 w-full min-w-0 max-w-full rounded-md border border-border bg-background p-2 font-mono text-xs dir-ltr"
                  dir="ltr"
                  value={stepType === "HTTP_REQUEST" && curlMode ? curlText : configText}
                  onChange={(e) =>
                    stepType === "HTTP_REQUEST" && curlMode
                      ? setCurlText(e.target.value)
                      : setConfigText(e.target.value)
                  }
                  placeholder={
                    stepType === "HTTP_REQUEST" && curlMode
                      ? t("scenarios.curlPlaceholder")
                      : configPlaceholder
                  }
                />
                {stepType === "HTTP_REQUEST" && curlMode && curlParsed?.ok ? (
                  <p className="dir-ltr break-all font-mono text-[11px] text-muted-foreground">
                    {curlParsed.config.method} {curlParsed.config.url}
                  </p>
                ) : null}
                {stepType === "HTTP_REQUEST" && curlMode && curlParsed && !curlParsed.ok ? (
                  <p className="text-xs text-destructive">
                    {t(`scenarios.curlErrors.${curlParsed.code}`)}
                  </p>
                ) : null}
                </>
                )}
                {editingStepId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingStepId(null);
                      applyTemplate("");
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
            ) : null}

            <div className="min-w-0 space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("scenarios.workflow")}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {t("scenarios.autoBindHint")}
              </p>
              {selected.steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
              ) : (
                <ScenarioFlow
                  steps={selected.steps}
                  selectedId={selectedStepId}
                  onSelect={(id) =>
                    setSelectedStepId((current) => (current === id ? null : id))
                  }
                  statuses={(liveRun ?? selected.runs?.[0])?.stepRuns?.map(
                    (run) => run.status,
                  ) ?? []}
                  formatNumber={n}
                  typeLabel={(type) => label("stepType", type)}
                  disabledLabel={t("scenarios.disabled")}
                  usesLabel={t("scenarios.flow.uses")}
                  producesLabel={t("scenarios.flow.produces")}
                  meta={Object.fromEntries(
                    selected.steps.map((item) => {
                      const stepNo = (id: string) =>
                        selected.steps.findIndex((candidate) => candidate.id === id) + 1;
                      // Design-time links carry their producer ("#1.bikerId");
                      // runtime-consumed variables come from the latest run.
                      const uses = [
                        ...(analysis?.dependencies
                          .filter((dep) => dep.consumerStepId === item.id)
                          .map((dep) => `#${n(stepNo(dep.producerStepId))}.${dep.variable}`) ?? []),
                      ];
                      const outputs = [
                        ...new Set(
                          analysis?.dependencies
                            .filter((dep) => dep.producerStepId === item.id)
                            .map((dep) => dep.variable) ?? [],
                        ),
                      ];
                      if (item.type === "EXTRACT_VARIABLE" && typeof item.config.variable === "string") {
                        outputs.push(item.config.variable);
                      }
                      const issue = analysis?.issues.find((problem) => problem.stepId === item.id);
                      const run = (liveRun ?? selected.runs?.[0])?.stepRuns?.find(
                        (stepRun) => stepRun.name === item.name,
                      );
                      const consumedAtRun = (() => {
                        const output = run?.output;
                        if (!output || typeof output !== "object" || !("consumedVars" in output)) return [];
                        const list = (output as { consumedVars?: unknown }).consumedVars;
                        return Array.isArray(list)
                          ? list
                              .map((entry) => (entry && typeof entry === "object" ? (entry as { variable?: unknown }).variable : null))
                              .filter((name): name is string => typeof name === "string")
                          : [];
                      })();
                      for (const name of consumedAtRun) {
                        if (!uses.some((entry) => entry.endsWith(`.${name}`))) uses.push(name);
                      }
                      return [item.id, {
                        uses: [...new Set(uses)],
                        outputs: [...new Set(outputs)],
                        durationMs: run?.durationMs,
                        issue: issue ? `${issue.detail}` : undefined,
                      }];
                    }),
                  )}
                />
              )}
              {(() => {
                const step = selected.steps.find((item) => item.id === selectedStepId);
                if (!step) {
                  return (
                    <p className="text-xs text-muted-foreground">
                      {t("scenarios.selectStep")}
                    </p>
                  );
                }
                const stepIndex = selected.steps.findIndex((item) => item.id === step.id);
                const stepRun = (liveRun ?? selected.runs?.[0])?.stepRuns?.[stepIndex];
                return (
                  <Card className="min-w-0">
                    <CardHeader>
                      <CardTitle>{t("scenarios.stepDetails")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{step.name}</span>
                        <Badge>{label("stepType", step.type)}</Badge>
                        {stepRun ? (
                          <Badge className={statusTone(stepRun.status)}>
                            {statusLabel(stepRun.status)}
                          </Badge>
                        ) : null}
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t("scenarios.request")}
                        </div>
                        <pre className="mt-1 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2 font-mono text-[10px] text-muted-foreground dir-ltr">
                          {JSON.stringify(step.config, null, 2)}
                        </pre>
                      </div>
                      {stepRun?.resolvedInput ? (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t("scenarios.sentRequest")}
                          </div>
                          <pre className="mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2 font-mono text-[10px] text-muted-foreground dir-ltr">
                            {JSON.stringify(stepRun.resolvedInput, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                      {step.type === "HTTP_REQUEST" ? (
                        <div className="grid gap-2 md:grid-cols-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              {t("scenarios.template")}
                            </div>
                            <p className="mt-1 break-all font-mono text-[11px] dir-ltr">
                              {String(step.config.method ?? "GET")} {String(step.config.url ?? "")}
                            </p>
                          </div>
                          {stepRun?.resolvedInput && typeof stepRun.resolvedInput === "object" ? (
                            <div>
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t("scenarios.resolved")}
                              </div>
                              <p className="mt-1 break-all font-mono text-[11px] dir-ltr">
                                {String((stepRun.resolvedInput as { method?: string }).method ?? "")}{" "}
                                {String((stepRun.resolvedInput as { url?: string }).url ?? "")}
                              </p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {stepRun ? <FlowTrace output={stepRun.output} extractedVars={stepRun.extractedVars} /> : null}
                      {stepRun?.output ? (
                        <div className="space-y-2">
                          <SmartResponse
                            analysis={analysis?.responses.find((item) => item.stepId === step.id)?.analysis ?? null}
                            raw={stepRun.output}
                            formatNumber={n}
                            labels={{
                              smart: t("scenarios.smartView"),
                              raw: t("scenarios.rawView"),
                              important: t("scenarios.importantData"),
                              outputs: t("scenarios.detectedOutputs"),
                            }}
                          />
                          <JsonTree
                            value={(stepRun.output as { body?: unknown }).body ?? stepRun.output}
                            extractLabel={t("scenarios.detectedOutputs")}
                            assertLabel={t("scenarios.accept")}
                            onExtract={(path) => {
                              const variable = path.split(".").pop()?.replace(/[^A-Za-z0-9_]/g, "") || "value";
                              void api(`/scenarios/${selected.id}/steps`, {
                                method: "POST",
                                body: JSON.stringify({
                                  name: variable,
                                  type: "EXTRACT_VARIABLE",
                                  config: { variable, path: path.replace(/^\$\.?/, "body.") },
                                }),
                              }).then(() => refreshSelected(selected.id));
                            }}
                            onAssert={(path, fieldValue) => {
                              void api(`/scenarios/${selected.id}/steps`, {
                                method: "POST",
                                body: JSON.stringify({
                                  name: path,
                                  type: "ASSERTION",
                                  config: {
                                    kind: "equals",
                                    path: path.replace(/^\$\.?/, "body."),
                                    expected: fieldValue,
                                  },
                                }),
                              }).then(() => refreshSelected(selected.id));
                            }}
                          />
                        </div>
                      ) : null}
                      {stepRun?.error ? (
                        <p className="text-xs text-destructive">{err(stepRun.error)}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => moveStep(step.id, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => moveStep(step.id, 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingStepId(step.id);
                            setStepType(step.type as (typeof STEP_TYPES)[number]);
                            setStepName(step.name);
                            setConfigText(JSON.stringify(step.config, null, 2));
                            setDbStep(
                              step.type === "DATABASE_ACTION"
                                ? databaseStepFromConfig(step.config)
                                : EMPTY_DATABASE_STEP,
                            );
                            setCurlMode(false);
                            setCurlText("");
                          }}
                        >
                          {t("common.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            await api(`/scenarios/steps/${step.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ enabled: !step.enabled }),
                            });
                            await refreshSelected(selected.id);
                          }}
                        >
                          {step.enabled ? t("common.disable") : t("common.enable")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            await api(`/scenarios/steps/${step.id}/duplicate`, {
                              method: "POST",
                              body: "{}",
                            });
                            await refreshSelected(selected.id);
                          }}
                        >
                          {t("scenarios.dup")}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={async () => {
                            if (!window.confirm(t("common.confirmDelete", { name: step.name }))) return;
                            await api(`/scenarios/steps/${step.id}`, {
                              method: "DELETE",
                            });
                            setSelectedStepId(null);
                            await refreshSelected(selected.id);
                          }}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })()}
            </div>

            <div className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("scenarios.history")}
              </h2>
              {(selected.runs ?? []).map((run) => {
                const open = expandedRunId === run.id;
                return (
                  <Card key={run.id}>
                    <CardContent className="space-y-2 p-3">
                      <button
                        className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 text-sm"
                        onClick={() =>
                          setExpandedRunId(open ? null : run.id)
                        }
                      >
                        <span className="flex items-center gap-2">
                          <Badge className={statusTone(run.status)}>
                            {statusLabel(run.status)}
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {run.id.slice(0, 10)}
                          </span>
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {n(run.durationMs ?? 0)}ms · {open ? "▾" : "▸"}
                        </span>
                      </button>
                      {run.error ? (
                        <p className="text-xs text-destructive">{err(run.error)}</p>
                      ) : null}
                      {open ? (
                        <div className="space-y-2">
                          {run.stepRuns?.map((sr) => (
                            <StepRunFacts
                              key={sr.id}
                              name={sr.name}
                              typeLabel={label("stepType", sr.type)}
                              status={sr.status}
                              statusLabel={statusLabel(sr.status)}
                              durationMs={sr.durationMs}
                              error={sr.error}
                              resolvedInput={sr.resolvedInput}
                              output={sr.output}
                              extractedVars={sr.extractedVars}
                              formatNumber={n}
                              formatDate={d}
                              learnedLabel={t("scenarios.learned")}
                              rawLabel={t("scenarios.rawLog")}
                            >
                              <FlowTrace output={sr.output} extractedVars={sr.extractedVars} />
                            </StepRunFacts>
                          ))}
                          <VariableFacts
                            title={t("scenarios.finalVars")}
                            value={run.variablesJson}
                            formatNumber={n}
                            formatDate={d}
                          />
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>
      {importOpen && selected ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-lg rounded-md border border-border bg-background p-4"
          >
            <h2 className="text-sm font-medium">{t("scenarios.importCurl")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("scenarios.importCurlHint")}</p>
            <textarea
              className="mt-3 min-h-40 w-full rounded-md border border-border bg-background p-2 font-mono text-xs dir-ltr"
              dir="ltr"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={t("scenarios.curlPlaceholder")}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setImportOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                disabled={!importText.trim()}
                onClick={() => {
                  void (async () => {
                    try {
                      await api(`/scenarios/${selected.id}/import-curl`, {
                        method: "POST",
                        body: JSON.stringify({ text: importText }),
                      });
                      setImportText("");
                      setImportOpen(false);
                      await refreshSelected(selected.id);
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Request failed");
                    }
                  })();
                }}
              >
                {t("scenarios.importCurl")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
