"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileUp, Plus, Search, Wand2 } from "lucide-react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import {
  ACTIVE_RUN,
  sameTarget,
  stateTone,
  type Env,
  type FlowAnalysis,
  type Scenario,
  type ScenarioRun,
  type Step,
  type StepBinding,
  type Suggestion,
} from "@/components/scenarios/builder-types";
import { CurlImportDialog } from "@/components/scenarios/curl-import-dialog";
import { DatabaseStepDialog } from "@/components/scenarios/database-step-dialog";
import { UiRecordDialog } from "@/components/scenarios/ui-step";
import type { ConnectorChoice } from "@/components/scenarios/database-step-form";
import type { ManualChoice } from "@/components/scenarios/manual-recovery";
import { RequestFlow } from "@/components/scenarios/request-flow";
import { DetectedBanner, ScenarioOverview } from "@/components/scenarios/scenario-overview";
import { StepPanel, type StepActions } from "@/components/scenarios/step-panel";
import { ValuePicker, type PickerRequest } from "@/components/scenarios/value-picker";

/** Starting configuration of a step added by hand (the step is edited right after). */
const TEMPLATES: Record<string, Record<string, unknown>> = {
  HTTP_REQUEST: { method: "GET", url: "", headers: {}, query: {}, body: {}, timeoutMs: 15000 },
  ASSERTION: { kind: "status_code", expected: 200 },
  DELAY: { ms: 1000 },
  SET_VARIABLE: { variable: "name", value: "" },
  EXTRACT_VARIABLE: { variable: "name", path: "body.data.id" },
  CONDITION: { left: "{{status}}", op: "equals", right: "OK" },
};
const OTHER_TYPES = ["UI_FLOW", "ASSERTION", "DELAY", "DATABASE_ACTION", "SET_VARIABLE", "EXTRACT_VARIABLE", "CONDITION"];
const POLL_MS = 500;

function readDismissed(scenarioId: string): string[] {
  try {
    const raw = window.localStorage.getItem(`qa-workbench.dismissed.${scenarioId}`);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(scenarioId: string, ids: string[]) {
  try {
    window.localStorage.setItem(`qa-workbench.dismissed.${scenarioId}`, JSON.stringify(ids.slice(-500)));
  } catch {
    // storage unavailable: dismissals last for this visit only
  }
}

export default function ScenariosPage() {
  const { t, n, err, label } = useI18n();
  const toast = useToast();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [envs, setEnvs] = useState<Env[]>([]);
  const [connectors, setConnectors] = useState<ConnectorChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Scenario | null>(null);
  const [analysis, setAnalysis] = useState<FlowAnalysis | null>(null);
  const [liveRun, setLiveRun] = useState<ScenarioRun | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [dbStepOpen, setDbStepOpen] = useState(false);
  const [uiRecord, setUiRecord] = useState<{ step: Step | null } | null>(null);
  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => Promise<void> } | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef<string | null>(null);

  const fail = useCallback((error: unknown) => toast.notify("error", err(error instanceof Error ? error.message : "Request failed")), [toast, err]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const loadList = useCallback(async () => {
    const list = await api<Scenario[]>("/scenarios");
    setScenarios(list);
    return list;
  }, []);

  /** Scenario detail and its design-time analysis (suggestions, mapping health, request fields). */
  const loadScenario = useCallback(async (id: string) => {
    const [scenario, flow] = await Promise.all([
      api<Scenario>(`/scenarios/${id}`),
      api<FlowAnalysis>(`/scenarios/${id}/analyze-flow`, { method: "POST", body: "{}" }).catch(() => null),
    ]);
    if (selectedRef.current !== id) return;
    setDetail(scenario);
    setAnalysis(flow);
    setScenarios((current) => current.map((item) => (item.id === id ? { ...item, ...scenario, runs: scenario.runs.slice(0, 1) } : item)));
  }, []);

  const poll = useCallback(
    (runId: string, scenarioId: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const run = await api<ScenarioRun>(`/scenarios/runs/${runId}`);
          if (selectedRef.current !== scenarioId) return;
          setLiveRun(run);
          if (ACTIVE_RUN.has(run.status)) {
            pollRef.current = setTimeout(() => void tick(), POLL_MS);
            return;
          }
          setBusy(false);
          await loadScenario(scenarioId);
          setLiveRun(null);
        } catch (error) {
          setBusy(false);
          fail(error);
        }
      };
      pollRef.current = setTimeout(() => void tick(), POLL_MS);
    },
    [stopPolling, loadScenario, fail],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [list, environmentList, connectorList] = await Promise.all([
          api<Scenario[]>("/scenarios"),
          api<Env[]>("/environments"),
          api<ConnectorChoice[]>("/database-connectors").catch(() => []),
        ]);
        if (!alive) return;
        setScenarios(list);
        setEnvs(environmentList);
        setConnectors(connectorList);
        setSelectedId((current) => current ?? list[0]?.id ?? null);
      } catch (error) {
        if (alive) fail(error);
      }
    })();
    return () => {
      alive = false;
      stopPolling();
    };
  }, [stopPolling, fail]);

  useEffect(() => {
    selectedRef.current = selectedId;
    stopPolling();
    setLiveRun(null);
    setDetail(null);
    setAnalysis(null);
    setSelectedStepId(null);
    setBusy(false);
    if (!selectedId) return;
    setDismissed(readDismissed(selectedId));
    void loadScenario(selectedId).catch(fail);
  }, [selectedId, loadScenario, stopPolling, fail]);

  // A run still going when the page opens (another tab, a reload) is followed live.
  useEffect(() => {
    const latest = detail?.runs[0];
    if (detail && latest && ACTIVE_RUN.has(latest.status) && !pollRef.current) {
      setBusy(true);
      poll(latest.id, detail.id);
    }
  }, [detail, poll]);

  const steps = useMemo(() => [...(detail?.steps ?? [])].sort((a, b) => a.orderIndex - b.orderIndex), [detail]);
  const run = liveRun ?? detail?.runs[0] ?? null;
  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? null;
  const stepNumber = useCallback((id: string | undefined) => steps.findIndex((step) => step.id === id) + 1, [steps]);
  const suggestions = useMemo(
    () => (analysis?.dependencies ?? []).filter((item) => !dismissed.includes(item.id)),
    [analysis, dismissed],
  );
  const awaitingStepId = run?.live?.awaitingInput ? (run.live.stepId ?? null) : null;

  // The step waiting for input opens by itself.
  useEffect(() => {
    if (awaitingStepId) setSelectedStepId(awaitingStepId);
  }, [awaitingStepId]);

  const refresh = async () => {
    if (selectedId) await loadScenario(selectedId);
  };

  const guarded = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      fail(error);
    }
  };

  const startRun = async (untilStepId?: string) => {
    if (!detail) return;
    setBusy(true);
    try {
      const started = await api<ScenarioRun>(`/scenarios/${detail.id}/run`, {
        method: "POST",
        body: JSON.stringify(untilStepId ? { untilStepId } : {}),
      });
      setLiveRun(started);
      poll(started.id, detail.id);
    } catch (error) {
      setBusy(false);
      fail(error);
    }
  };

  const patchScenario = (data: Record<string, unknown>) =>
    guarded(async () => {
      if (!detail) return;
      await api(`/scenarios/${detail.id}`, { method: "PATCH", body: JSON.stringify(data) });
      await Promise.all([refresh(), loadList()]);
    });

  const saveBinding = async (stepId: string, binding: StepBinding) => {
    await api(`/scenarios/steps/${stepId}/bindings`, { method: "POST", body: JSON.stringify(binding) });
  };

  const dismiss = (suggestion: Suggestion) => {
    if (!detail) return;
    const next = [...dismissed, suggestion.id];
    setDismissed(next);
    writeDismissed(detail.id, next);
  };

  const accept = (list: Suggestion[]) =>
    guarded(async () => {
      if (!detail) return;
      for (const suggestion of list) {
        try {
          await api(`/scenarios/${detail.id}/dependencies/accept`, { method: "POST", body: JSON.stringify({ id: suggestion.id }) });
        } catch (error) {
          if (error instanceof Error && error.message === "A manual mapping already exists for this field") {
            if (!window.confirm(t("builder.detected.replaceManual"))) continue;
            await api(`/scenarios/${detail.id}/dependencies/accept`, {
              method: "POST",
              body: JSON.stringify({ id: suggestion.id, replace: true }),
            });
          } else {
            throw error;
          }
        }
      }
      await refresh();
    });

  /** Find which earlier response every unmapped field should use, and save the clear ones. */
  const autoMap = (stepId?: string) =>
    guarded(async () => {
      if (!detail) return;
      const result = await api<{ added: number; ambiguous: number; weak: number; usedResponses: boolean }>(`/scenarios/${detail.id}/dependencies/auto`, {
        method: "POST",
        body: JSON.stringify(stepId ? { stepId } : {}),
      });
      const parts = [
        result.added > 0 ? t("builder.autoMap.added", { count: n(result.added) }) : t("builder.autoMap.none"),
        result.ambiguous + result.weak > 0 ? t("builder.autoMap.left", { count: n(result.ambiguous + result.weak) }) : "",
        result.usedResponses ? "" : t("builder.autoMap.runFirst"),
      ].filter(Boolean);
      toast.notify(result.added > 0 ? "success" : "info", parts.join(" "));
      await refresh();
    });

  const createStep = async (type: string, name: string, config: Record<string, unknown>) => {
    if (!detail) return;
    const created = await api<Step>(`/scenarios/${detail.id}/steps`, {
      method: "POST",
      body: JSON.stringify({ name, type, config }),
    });
    await refresh();
    setSelectedStepId(created.id);
  };

  const addStep = (type: string) => {
    // A database step needs a connector and a valid query before the API accepts it.
    if (type === "DATABASE_ACTION") {
      setDbStepOpen(true);
      return;
    }
    // A UI step is recorded in a browser first.
    if (type === "UI_FLOW") {
      setUiRecord({ step: null });
      return;
    }
    void guarded(() =>
      createStep(type, type === "HTTP_REQUEST" ? t("builder.flow.newRequestName") : label("stepType", type), TEMPLATES[type] ?? {}),
    );
  };

  const moveStep = (step: Step, direction: -1 | 1) =>
    guarded(async () => {
      if (!detail) return;
      const ids = steps.map((item) => item.id);
      const index = ids.indexOf(step.id);
      const swap = index + direction;
      if (index < 0 || swap < 0 || swap >= ids.length) return;
      [ids[index], ids[swap]] = [ids[swap]!, ids[index]!];
      await api(`/scenarios/${detail.id}/reorder`, { method: "POST", body: JSON.stringify({ stepIds: ids }) });
      await refresh();
    });

  const deleteStep = (step: Step) =>
    setConfirm({
      title: t("builder.flow.delete"),
      body: t("builder.flow.confirmDelete", { name: step.name }),
      action: async () => {
        await api(`/scenarios/steps/${step.id}`, { method: "DELETE" });
        if (selectedStepId === step.id) setSelectedStepId(null);
        await refresh();
      },
    });

  const actions: StepActions = {
    pick: setPicker,
    saveStep: async (stepId, patch) =>
      guarded(async () => {
        await api(`/scenarios/steps/${stepId}`, { method: "PATCH", body: JSON.stringify(patch) });
        await refresh();
      }),
    runUntil: (step) => void startRun(step.id),
    toggleBinding: (stepId, binding) =>
      void guarded(async () => {
        await saveBinding(stepId, { ...binding, enabled: binding.enabled === false });
        await refresh();
      }),
    removeBinding: (stepId, binding) =>
      void guarded(async () => {
        await api(`/scenarios/steps/${stepId}/bindings/remove`, {
          method: "POST",
          body: JSON.stringify({ location: binding.target.location, field: binding.target.field }),
        });
        await refresh();
      }),
    accept: (suggestion) => void accept([suggestion]),
    dismiss,
    autoMap: (stepId) => void autoMap(stepId),
    recordUi: (step) => setUiRecord({ step }),
    addAssertion: (step, path, value) =>
      guarded(async () => {
        if (!detail) return;
        const created = await api<Step>(`/scenarios/${detail.id}/steps`, {
          method: "POST",
          body: JSON.stringify({
            name: path,
            type: "ASSERTION",
            config: { kind: "equals", path: path.replace(/^\$\.?/, "body."), expected: value },
          }),
        });
        // Assertions check the request right before them: place it after this step and its other assertions.
        const ids = steps.map((item) => item.id);
        let at = ids.indexOf(step.id) + 1;
        while (at < steps.length && steps[at]!.type === "ASSERTION") at += 1;
        ids.splice(at, 0, created.id);
        await api(`/scenarios/${detail.id}/reorder`, { method: "POST", body: JSON.stringify({ stepIds: ids }) });
        toast.notify("success", t("builder.assertions.added"));
        await refresh();
      }),
    deleteStep,
    resolve: async (choice: ManualChoice) =>
      guarded(async () => {
        if (!run) return;
        const next = await api<ScenarioRun>(`/scenarios/runs/${run.id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ changes: [{ target: choice.target, source: choice.source }], save: choice.save }),
        });
        setLiveRun(next);
      }),
    skipInput: async () =>
      guarded(async () => {
        if (!run) return;
        setLiveRun(await api<ScenarioRun>(`/scenarios/runs/${run.id}/skip-input`, { method: "POST", body: "{}" }));
      }),
  };

  const visible = scenarios.filter((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const targetLabel = (suggestion: Suggestion) =>
    `${t(`builder.picker.locations.${suggestion.target.location}`)} · ${suggestion.target.key}`;

  return (
    <div className="mx-auto grid min-w-0 max-w-[1500px] grid-cols-1 gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-2" aria-label={t("nav.scenarios")}>
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newName.trim()) return;
            void guarded(async () => {
              const created = await api<Scenario>("/scenarios", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
              setNewName("");
              await loadList();
              setSelectedId(created.id);
            });
          }}
        >
          <input
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
            aria-label={t("builder.namePlaceholder")}
            placeholder={t("builder.newScenario")}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button type="submit" size="icon" aria-label={t("builder.newScenario")} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </form>
        {scenarios.length > 6 ? (
          <label className="relative block">
            <span className="sr-only">{t("builder.search")}</span>
            <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-8 w-full rounded-md border border-border bg-background ps-7 pe-2 text-xs"
              placeholder={t("builder.search")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
        ) : null}
        {scenarios.length === 0 ? <p className="px-1 text-xs text-muted-foreground">{t("builder.noScenarios")}</p> : null}
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-0.5 lg:overflow-visible">
          {visible.map((item) => {
            const last = item.runs[0];
            const tone = stateTone(last?.status ?? "NOT_RUN");
            return (
              <button
                key={item.id}
                type="button"
                aria-current={selectedId === item.id ? "page" : undefined}
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-start lg:w-full",
                  selectedId === item.id ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block max-w-48 truncate text-xs">{item.name}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {t("builder.requestsCount", { count: n(item.steps.length) })}
                    {last ? ` · ${label("status", last.status)}` : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="min-w-0">
        {!detail ? (
          <p className="text-sm text-muted-foreground">{selectedId ? t("common.loading") : t("builder.selectScenario")}</p>
        ) : (
          <div className={cn("grid min-w-0 gap-4", selectedStep && "xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]")}>
            <div className="min-w-0 space-y-3">
              <ScenarioOverview
                key={detail.id}
                scenario={detail}
                envs={envs}
                run={run}
                busy={busy}
                onRename={(name) => void patchScenario({ name })}
                onDescribe={(description) => void patchScenario({ description })}
                onEnvironment={(environmentId) => void patchScenario({ environmentId })}
                onStopOnFailure={(stopOnFailure) => void patchScenario({ stopOnFailure })}
                onRun={() => void startRun()}
                onStop={() =>
                  void guarded(async () => {
                    if (run) await api(`/scenarios/runs/${run.id}/cancel`, { method: "POST", body: "{}" });
                  })
                }
                onDuplicate={() =>
                  void guarded(async () => {
                    const copy = await api<Scenario>(`/scenarios/${detail.id}/duplicate`, { method: "POST", body: "{}" });
                    await loadList();
                    setSelectedId(copy.id);
                  })
                }
                onDelete={() =>
                  setConfirm({
                    title: t("builder.overview.delete"),
                    body: t("common.confirmDelete", { name: detail.name }),
                    action: async () => {
                      await api(`/scenarios/${detail.id}`, { method: "DELETE" });
                      const list = await loadList();
                      setSelectedId(list[0]?.id ?? null);
                    },
                  })
                }
              />

              <DetectedBanner
                suggestions={suggestions}
                stepNumber={stepNumber}
                targetLabel={targetLabel}
                onAccept={(suggestion) => void accept([suggestion])}
                onAcceptMany={(list) => void accept(list)}
                onDismiss={dismiss}
              />

              <section className="space-y-2" aria-labelledby="flow-title">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="flow-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("builder.flow.title")}
                  </h2>
                  <div className="ms-auto flex flex-wrap gap-1.5">
                    {steps.filter((step) => step.type === "HTTP_REQUEST").length > 1 ? (
                      <Button size="sm" variant="outline" title={t("builder.autoMap.hint")} onClick={() => void autoMap()}>
                        <Wand2 className="h-3.5 w-3.5" />
                        {t("builder.autoMap.button")}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                      <FileUp className="h-3.5 w-3.5" />
                      {t("builder.flow.importCurl")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void addStep("HTTP_REQUEST")}>
                      <Plus className="h-3.5 w-3.5" />
                      {t("builder.flow.addRequest")}
                    </Button>
                    <Menu
                      label={t("builder.flow.addOther")}
                      trigger={<ChevronDown className="h-4 w-4" />}
                      items={OTHER_TYPES.map((type) => ({ label: label("stepType", type), onSelect: () => void addStep(type) }))}
                    />
                  </div>
                </div>

                {steps.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
                    <p className="text-sm">{t("builder.flow.empty")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t("builder.flow.emptyHint")}</p>
                    <div className="mt-4 flex justify-center gap-2">
                      <Button onClick={() => setImportOpen(true)}>
                        <FileUp className="h-3.5 w-3.5" />
                        {t("builder.flow.importCurl")}
                      </Button>
                      <Button variant="outline" onClick={() => void addStep("HTTP_REQUEST")}>
                        {t("builder.flow.addRequest")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <RequestFlow
                    steps={steps}
                    run={run}
                    reviews={analysis?.mappings ?? []}
                    selectedId={selectedStepId}
                    busy={busy}
                    onSelect={(id) => setSelectedStepId((current) => (current === id ? null : id))}
                    onRunUntil={(step) => void startRun(step.id)}
                    onMove={(step, direction) => void moveStep(step, direction)}
                    onDuplicate={(step) =>
                      void guarded(async () => {
                        await api(`/scenarios/steps/${step.id}/duplicate`, { method: "POST", body: "{}" });
                        await refresh();
                      })
                    }
                    onToggle={(step) => void actions.saveStep(step.id, { enabled: !step.enabled })}
                    onDelete={deleteStep}
                  />
                )}
              </section>
            </div>

            {selectedStep ? (
              <>
                <div className="fixed inset-0 z-30 bg-black/50 xl:hidden" aria-hidden onClick={() => setSelectedStepId(null)} />
                <aside
                  aria-label={selectedStep.name}
                  className="fixed inset-y-0 end-0 z-40 w-full max-w-xl border-s border-border bg-background shadow-xl xl:sticky xl:top-0 xl:z-auto xl:h-[calc(100dvh-5.5rem)] xl:max-w-none xl:rounded-md xl:border xl:shadow-none"
                >
                  <StepPanel
                    key={selectedStep.id}
                    step={selectedStep}
                    steps={steps}
                    run={run}
                    analysis={analysis}
                    connectors={connectors}
                    suggestions={suggestions.filter((item) => item.consumerStepId === selectedStep.id)}
                    awaitingInput={awaitingStepId === selectedStep.id}
                    busy={busy}
                    actions={actions}
                    onClose={() => setSelectedStepId(null)}
                  />
                </aside>
              </>
            ) : null}
          </div>
        )}
      </div>

      {importOpen && detail ? (
        <CurlImportDialog
          scenarioId={detail.id}
          existingIds={steps.map((step) => step.id)}
          onClose={() => setImportOpen(false)}
          onImported={async ({ imported }) => {
            toast.notify("success", t("builder.import.done", { count: n(imported) }));
            await Promise.all([refresh(), loadList()]);
          }}
        />
      ) : null}

      {uiRecord && detail ? (
        <UiRecordDialog
          scenarioId={detail.id}
          step={uiRecord.step}
          onClose={() => setUiRecord(null)}
          onSaved={async (saved) => {
            toast.notify("success", t("uiStep.saved"));
            await refresh();
            setSelectedStepId(saved.id);
          }}
        />
      ) : null}

      {dbStepOpen && detail ? (
        <DatabaseStepDialog
          connectors={connectors}
          onClose={() => setDbStepOpen(false)}
          onCreate={(name, config) => createStep("DATABASE_ACTION", name, config)}
        />
      ) : null}

      {picker && detail ? (
        <ValuePicker
          request={picker}
          steps={steps}
          fieldsOf={(stepId) => analysis?.inputs.find((item) => item.stepId === stepId)?.fields ?? []}
          runOf={(stepId) => detail.runs.find((item) => !ACTIVE_RUN.has(item.status))?.stepRuns.find((item) => item.scenarioStepId === stepId)}
          onClose={() => setPicker(null)}
          onSave={async (stepId, binding, runAfter) => {
            try {
              const existing = analysis?.mappings.find((item) => item.stepId === stepId && sameTarget(item.binding.target, binding.target));
              await saveBinding(stepId, { ...binding, ...(existing?.binding.enabled === false ? { enabled: false } : {}) });
              await refresh();
              setSelectedStepId(stepId);
              if (runAfter) await startRun(stepId);
            } catch (error) {
              fail(error);
              throw error;
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          void guarded(async () => {
            const action = confirm?.action;
            setConfirm(null);
            await action?.();
          })
        }
      />
    </div>
  );
}
