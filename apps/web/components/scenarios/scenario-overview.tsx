"use client";

import { useState } from "react";
import { Code2, Copy, Play, RotateCcw, Sparkles, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import {
  ACTIVE_RUN,
  stateTone,
  stepStateOf,
  type Env,
  type Scenario,
  type ScenarioRun,
  type Step,
  type Suggestion,
} from "@/components/scenarios/builder-types";
import { SuggestionRow } from "@/components/scenarios/mapping-panel";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Name, environment, run controls and a one-line summary of the run being shown. */
export function ScenarioOverview({
  scenario,
  envs,
  run,
  busy,
  onRename,
  onDescribe,
  onEnvironment,
  onStopOnFailure,
  onRun,
  onStop,
  onDuplicate,
  onDelete,
  onExport,
}: {
  scenario: Scenario;
  envs: Env[];
  run: ScenarioRun | null;
  busy: boolean;
  onRename: (name: string) => void;
  onDescribe: (description: string) => void;
  onEnvironment: (id: string | null) => void;
  onStopOnFailure: (value: boolean) => void;
  onRun: () => void;
  onStop: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Open the export dialog (automation code for a test framework). */
  onExport: () => void;
}) {
  const { t, n, d, label, err } = useI18n();
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(scenario.name);
  const active = Boolean(run && ACTIVE_RUN.has(run.status));
  const steps = scenario.steps;
  const states = steps.map((step) => (step.enabled ? stepStateOf(step, run) : "SKIPPED"));
  const count = (...wanted: string[]) => states.filter((state) => wanted.includes(state)).length;
  const done = states.filter((state) => !["NOT_RUN", "PENDING", "RUNNING", "RECOVERING", "NEEDS_INPUT"].includes(state)).length;
  const tone = stateTone(run?.status ?? "NOT_RUN");
  const summary = [
    { key: "passed", value: count("PASSED", "RECOVERED"), className: "text-success" },
    { key: "failed", value: count("FAILED", "BLOCKED", "NEEDS_INPUT", "CANCELLED"), className: "text-destructive" },
    { key: "skipped", value: count("SKIPPED"), className: "text-muted-foreground" },
    { key: "pending", value: count("NOT_RUN", "PENDING", "RUNNING", "RECOVERING"), className: "text-muted-foreground" },
  ];

  return (
    <section className="space-y-3 rounded-md border border-border bg-card px-4 py-3" aria-labelledby="scenario-title">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          {editingName ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) onRename(name.trim());
                setEditingName(false);
              }}
            >
              <input
                autoFocus
                aria-label={t("common.name")}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-base font-semibold"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (name.trim() && name.trim() !== scenario.name) onRename(name.trim());
                  setEditingName(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setName(scenario.name);
                    setEditingName(false);
                  }
                }}
              />
            </form>
          ) : (
            <h1 id="scenario-title" className="break-words text-base font-semibold">
              <button
                type="button"
                className="rounded text-start hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={t("builder.overview.rename")}
                onClick={() => {
                  setName(scenario.name);
                  setEditingName(true);
                }}
              >
                {scenario.name}
              </button>
            </h1>
          )}
          <input
            key={scenario.id + scenario.description}
            aria-label={t("common.description")}
            className="w-full rounded border border-transparent bg-transparent px-0 text-xs text-muted-foreground placeholder:text-muted-foreground/60 hover:border-border focus:border-border focus:px-1 focus:outline-none"
            defaultValue={scenario.description}
            placeholder={t("builder.overview.descriptionPlaceholder")}
            onBlur={(event) => {
              if (event.target.value !== scenario.description) onDescribe(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="sr-only sm:not-sr-only">{t("builder.overview.environment")}</span>
            <select
              className="h-8 max-w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              value={scenario.environmentId ?? ""}
              disabled={active}
              onChange={(event) => onEnvironment(event.target.value || null)}
            >
              <option value="">{t("builder.overview.noEnvironment")}</option>
              {envs.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </label>
          <Button variant="outline" disabled={steps.length === 0} title={t("builder.export.hint")} onClick={onExport}>
            <Code2 className="h-3.5 w-3.5" />
            {t("builder.export.button")}
          </Button>
          {active ? (
            <Button variant="destructive" onClick={onStop}>
              <Square className="h-3.5 w-3.5" />
              {t("builder.overview.stop")}
            </Button>
          ) : (
            <Button disabled={busy || steps.length === 0} onClick={onRun}>
              {run ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {run ? t("builder.overview.rerun") : t("builder.overview.run")}
            </Button>
          )}
          <Menu
            label={t("builder.overview.more")}
            items={[
              {
                label: `${scenario.stopOnFailure ? "✓ " : ""}${t("builder.overview.stopOnFailure")}`,
                onSelect: () => onStopOnFailure(!scenario.stopOnFailure),
              },
              { label: t("builder.overview.duplicate"), icon: <Copy className="h-3.5 w-3.5" />, onSelect: onDuplicate },
              { label: t("builder.overview.delete"), icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, onSelect: onDelete },
            ]}
          />
        </div>
      </div>

      {run ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className={cn("inline-flex items-center gap-1.5 font-medium", tone.text)}>
              <span className={cn("h-2 w-2 rounded-full", tone.dot)} aria-hidden />
              {label("status", run.status)}
            </span>
            {summary.map((item) =>
              item.value > 0 ? (
                <span key={item.key} className={item.className}>
                  {n(item.value)} {t(`builder.overview.summary.${item.key}`)}
                </span>
              ) : null,
            )}
            <span className="ms-auto text-[11px] text-muted-foreground">
              {active
                ? t("builder.overview.progress", { done: n(done), total: n(steps.length) })
                : run.finishedAt || run.createdAt
                  ? t("builder.overview.lastRun", { when: d(run.finishedAt ?? run.createdAt!) })
                  : null}
            </span>
          </div>
          <div
            className="flex h-1.5 gap-0.5 overflow-hidden rounded-sm"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={done}
            aria-label={t("builder.overview.progress", { done: n(done), total: n(steps.length) })}
          >
            {steps.map((step: Step, index) => (
              <span key={step.id} className={cn("h-full flex-1", stateTone(states[index]!).dot)} />
            ))}
          </div>
          {run.error && !active ? <p className="text-[11px] text-destructive">{err(run.error)}</p> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("builder.neverRun")}</p>
      )}
    </section>
  );
}

/** Detected connections waiting for a decision, collapsed to one line until opened. */
export function DetectedBanner({
  suggestions,
  stepNumber,
  targetLabel,
  onAccept,
  onAcceptMany,
  onDismiss,
}: {
  suggestions: Suggestion[];
  stepNumber: (id: string) => number;
  targetLabel: (suggestion: Suggestion) => string;
  onAccept: (suggestion: Suggestion) => void;
  onAcceptMany: (suggestions: Suggestion[]) => void;
  onDismiss: (suggestion: Suggestion) => void;
}) {
  const { t, n } = useI18n();
  const [open, setOpen] = useState(false);
  if (suggestions.length === 0) return null;
  const likely = suggestions.filter((item) => item.confidence !== "LOW");
  return (
    <section className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2" aria-labelledby="detected-title">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <h2 id="detected-title" className="text-xs font-medium">
          {t("builder.detected.title", { count: n(suggestions.length) })}
        </h2>
        <div className="ms-auto flex gap-1">
          {likely.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => onAcceptMany(likely)}>
              {t("builder.detected.acceptLikely", { count: n(likely.length) })}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
            {open ? t("builder.detected.hide") : t("builder.detected.review")}
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-muted-foreground">{t("builder.detected.hint")}</p>
          <ul className="max-h-80 space-y-1.5 overflow-auto">
            {suggestions.map((suggestion) => (
              <SuggestionRow
                key={suggestion.id}
                suggestion={suggestion}
                producerNumber={stepNumber(suggestion.producerStepId)}
                consumerNumber={stepNumber(suggestion.consumerStepId)}
                targetLabel={targetLabel(suggestion)}
                showConsumer
                onAccept={() => onAccept(suggestion)}
                onDismiss={() => onDismiss(suggestion)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
