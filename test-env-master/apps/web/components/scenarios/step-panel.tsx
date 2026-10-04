"use client";

import { useState } from "react";
import { CheckSquare, Forward, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AttemptHistory } from "@/components/scenarios/attempt-history";
import {
  NEEDS_REVIEW,
  httpSummary,
  outputOf,
  stateTone,
  stepRunOf,
  stepStateOf,
  type FlowAnalysis,
  type ScenarioRun,
  type Step,
  type StepBinding,
  type Suggestion,
} from "@/components/scenarios/builder-types";
import type { ConnectorChoice } from "@/components/scenarios/database-step-form";
import { ManualRecovery, type ManualChoice } from "@/components/scenarios/manual-recovery";
import { MappingPanel } from "@/components/scenarios/mapping-panel";
import { RequestEditor, RequestView } from "@/components/scenarios/request-tab";
import { ResponseExplorer } from "@/components/scenarios/response-explorer";
import { AssertionsTab, StepSettings } from "@/components/scenarios/step-settings";
import type { PickerRequest } from "@/components/scenarios/value-picker";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Tab = "request" | "response" | "mapping" | "assertions" | "attempts" | "settings";

export type StepActions = {
  pick: (request: PickerRequest) => void;
  saveStep: (stepId: string, patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> }) => Promise<void>;
  runUntil: (step: Step) => void;
  toggleBinding: (stepId: string, binding: StepBinding) => void;
  removeBinding: (stepId: string, binding: StepBinding) => void;
  accept: (suggestion: Suggestion) => void;
  dismiss: (suggestion: Suggestion) => void;
  addAssertion: (step: Step, path: string, value: unknown) => Promise<void>;
  deleteStep: (step: Step) => void;
  resolve: (choice: ManualChoice) => Promise<void>;
  skipInput: () => Promise<void>;
};

/** Focused details of one step: request, response, mappings, assertions, attempts, advanced settings. */
export function StepPanel({
  step,
  steps,
  run,
  analysis,
  connectors,
  suggestions,
  awaitingInput,
  busy,
  actions,
  onClose,
}: {
  step: Step;
  steps: Step[];
  run: ScenarioRun | null;
  analysis: FlowAnalysis | null;
  connectors: ConnectorChoice[];
  suggestions: Suggestion[];
  awaitingInput: boolean;
  busy: boolean;
  actions: StepActions;
  onClose: () => void;
}) {
  const { t, n, err, label } = useI18n();
  const http = step.type === "HTTP_REQUEST";
  const index = steps.findIndex((item) => item.id === step.id);
  const stepRun = stepRunOf(step, run);
  const output = outputOf(stepRun);
  const state = step.enabled ? stepStateOf(step, run) : "SKIPPED";
  const tone = stateTone(state);
  const reviews = (analysis?.mappings ?? []).filter((item) => item.stepId === step.id);
  const fields = analysis?.inputs.find((item) => item.stepId === step.id)?.fields ?? [];
  const broken = reviews.some((item) => NEEDS_REVIEW.includes(item.status));
  const attempts = output?.recovery?.attempts.length ?? 0;
  const laterHttp = steps.slice(index + 1).some((item) => item.type === "HTTP_REQUEST");
  const attached: Step[] = [];
  for (const next of steps.slice(index + 1)) {
    if (next.type !== "ASSERTION") break;
    attached.push(next);
  }
  const stepNumber = (id: string | undefined) => steps.findIndex((item) => item.id === id) + 1;

  const defaultTab: Tab = !http ? "settings" : output?.blocked?.length || broken ? "mapping" : "request";
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [editing, setEditing] = useState(false);
  const tabs: Array<{ id: Tab; badge?: string; warn?: boolean }> = http
    ? [
        { id: "request" },
        { id: "response" },
        { id: "mapping", badge: reviews.length ? n(reviews.length) : undefined, warn: broken || suggestions.length > 0 },
        { id: "assertions" },
        { id: "attempts", badge: attempts ? n(attempts) : undefined },
        { id: "settings" },
      ]
    : [{ id: "response" }, { id: "settings" }];

  const { method } = httpSummary(step.config);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground">
              {t("builder.flow.step", { n: n(index + 1) })} · {http ? method : label("stepType", step.type)}
            </p>
            <h2 className="break-words text-sm font-medium">{step.name}</h2>
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={t("builder.panel.close")}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex items-center gap-1.5 text-xs", tone.text)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} aria-hidden />
            {label("status", state)}
          </span>
          {typeof output?.status === "number" ? <span className="font-mono text-xs text-muted-foreground">HTTP {output.status}</span> : null}
          {stepRun?.durationMs ? <span className="text-xs text-muted-foreground">{t("builder.flow.ms", { value: n(stepRun.durationMs) })}</span> : null}
          <Button size="sm" variant="outline" className="ms-auto" disabled={busy} onClick={() => actions.runUntil(step)}>
            <Play className="h-3.5 w-3.5" />
            {t("builder.panel.runUntil")}
          </Button>
        </div>
        {stepRun?.error && !awaitingInput ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive" role="status">
            {err(stepRun.error)}
          </p>
        ) : null}
      </header>

      {awaitingInput ? (
        <div className="border-b border-border p-3">
          <ManualRecovery
            key={`${stepRun?.id}:${attempts}`}
            output={output}
            error={stepRun?.error}
            onRetry={actions.resolve}
            onSkip={actions.skipInput}
          />
        </div>
      ) : null}

      <div
        role="tablist"
        aria-label={step.name}
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-2"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          const ids = tabs.map((item) => item.id);
          const rtl = document.documentElement.dir === "rtl";
          const forward = (event.key === "ArrowRight") !== rtl;
          const next = ids[(ids.indexOf(tab) + (forward ? 1 : -1) + ids.length) % ids.length]!;
          setTab(next);
          document.getElementById(`step-tab-${next}`)?.focus();
        }}
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`step-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="step-tabpanel"
            tabIndex={tab === item.id ? 0 : -1}
            className={cn(
              "relative shrink-0 border-b-2 px-2.5 py-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              tab === item.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(item.id)}
          >
            {t(`builder.panel.tabs.${item.id}`)}
            {item.badge ? <span className="ms-1 text-[10px] text-muted-foreground">{item.badge}</span> : null}
            {item.warn ? <span className="absolute end-1 top-1.5 h-1.5 w-1.5 rounded-full bg-warning" aria-hidden /> : null}
          </button>
        ))}
      </div>

      <div id="step-tabpanel" role="tabpanel" aria-labelledby={`step-tab-${tab}`} className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "request" && http ? (
          editing ? (
            <RequestEditor
              step={step}
              onCancel={() => setEditing(false)}
              onSave={async (name, config) => {
                await actions.saveStep(step.id, { name, config });
                setEditing(false);
              }}
            />
          ) : (
            <div className="space-y-2">
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  {t("builder.request.edit")}
                </Button>
              </div>
              <RequestView step={step} fields={fields} reviews={reviews} lastRun={stepRun} stepNumber={stepNumber} onPick={actions.pick} />
            </div>
          )
        ) : null}

        {tab === "response" ? (
          !stepRun ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {t("builder.panel.runToSee")}
            </p>
          ) : http ? (
            output && (output.body !== undefined || output.headers) ? (
              <ResponseExplorer
                body={output.body}
                headers={output.headers}
                actions={(pick) => (
                  <>
                    {laterHttp ? (
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-primary"
                        title={t("builder.response.useLater")}
                        aria-label={`${t("builder.response.useLater")}: ${pick.label}`}
                        onClick={() => actions.pick({ source: { stepId: step.id, path: pick.path } })}
                      >
                        <Forward className="h-3.5 w-3.5 rtl:-scale-x-100" />
                      </button>
                    ) : null}
                    {!pick.secret && pick.path.startsWith("response.body") ? (
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-primary"
                        title={t("builder.response.assert")}
                        aria-label={`${t("builder.response.assert")}: ${pick.label}`}
                        onClick={() => void actions.addAssertion(step, pick.label, pick.value)}
                      >
                        <CheckSquare className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </>
                )}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{t("builder.panel.noRun")}</p>
            )
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border p-2 font-mono text-[11px] text-muted-foreground dir-ltr" dir="ltr">
              {JSON.stringify(stepRun.output ?? stepRun.resolvedInput ?? {}, null, 2)}
            </pre>
          )
        ) : null}

        {tab === "mapping" ? (
          <MappingPanel
            stepId={step.id}
            reviews={reviews}
            suggestions={suggestions}
            fields={fields}
            stepNumber={stepNumber}
            onPick={actions.pick}
            onToggle={(binding) => actions.toggleBinding(step.id, binding)}
            onRemove={(binding) => actions.removeBinding(step.id, binding)}
            onAccept={actions.accept}
            onDismiss={actions.dismiss}
          />
        ) : null}

        {tab === "assertions" ? (
          <AssertionsTab
            key={step.id}
            step={step}
            attached={attached}
            output={output}
            onSaveExpected={async (statuses) => {
              const config = { ...step.config };
              if (statuses.length === 0) delete config.expectedStatus;
              else config.expectedStatus = statuses.length === 1 ? statuses[0] : statuses;
              await actions.saveStep(step.id, { config });
            }}
            onDeleteAssertion={actions.deleteStep}
          />
        ) : null}

        {tab === "attempts" ? <AttemptHistory output={output} /> : null}

        {tab === "settings" ? (
          <StepSettings
            key={`${step.id}:${JSON.stringify(step.config).length}:${step.enabled}`}
            step={step}
            connectors={connectors}
            producers={analysis?.variables ?? []}
            environmentKeys={analysis?.environmentKeys ?? []}
            stepNumber={(producer) => stepNumber(producer.stepId) || producer.orderIndex + 1}
            sample={output ? { body: output.body, headers: output.headers } : null}
            onSave={(patch) => actions.saveStep(step.id, patch)}
          />
        ) : null}
      </div>
    </div>
  );
}
