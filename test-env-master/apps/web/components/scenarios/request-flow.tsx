"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Copy, Link2, MonitorPlay, Play, Power, Trash2, Video } from "lucide-react";
import { Menu } from "@/components/ui/menu";
import {
  httpSummary,
  NEEDS_REVIEW,
  outputOf,
  stateTone,
  stepRunOf,
  stepStateOf,
  type MappingReview,
  type ScenarioRun,
  type Step,
} from "@/components/scenarios/builder-types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The scenario as a vertical list of compact steps. A row shows only what is
 * needed at a glance; everything else lives in the step panel. Arrow keys move
 * between rows.
 */
export function RequestFlow({
  steps,
  run,
  reviews,
  selectedId,
  busy,
  onSelect,
  onRunUntil,
  onMove,
  onDuplicate,
  onToggle,
  onDelete,
  onRerecord,
}: {
  steps: Step[];
  run: ScenarioRun | null;
  reviews: MappingReview[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onRunUntil: (step: Step) => void;
  onMove: (step: Step, direction: -1 | 1) => void;
  onDuplicate: (step: Step) => void;
  onToggle: (step: Step) => void;
  onDelete: (step: Step) => void;
  /** Record a UI step again (all of it, or the part whose page changed). */
  onRerecord: (step: Step) => void;
}) {
  const { t, n, label } = useI18n();

  const focusRow = (index: number) => {
    document.querySelector<HTMLButtonElement>(`[data-flow-row="${index}"]`)?.focus();
  };

  return (
    <ol className="relative space-y-1.5" aria-label={t("builder.flow.title")}>
      {steps.map((step, index) => {
        const state = step.enabled ? stepStateOf(step, run) : "SKIPPED";
        const tone = stateTone(state);
        const stepRun = stepRunOf(step, run);
        const output = outputOf(stepRun);
        const own = reviews.filter((item) => item.stepId === step.id);
        const sources = [
          ...new Set(own.filter((item) => item.binding.enabled !== false && item.sourceStep).map((item) => item.sourceStep!)),
        ].sort((a, b) => a - b);
        const broken = own.some((item) => NEEDS_REVIEW.includes(item.status));
        const http = step.type === "HTTP_REQUEST";
        const ui = step.type === "UI_FLOW";
        const { method, url } = httpSummary(step.config);
        const uiCount = ui && Array.isArray(step.config.actions) ? step.config.actions.length : 0;
        const selected = selectedId === step.id;
        const failed = state === "FAILED" || state === "BLOCKED" || state === "NEEDS_INPUT";
        return (
          <li key={step.id} className="relative">
            <div
              className={cn(
                "group flex min-w-0 items-center gap-2 rounded-md border bg-card px-2 py-2 transition-colors",
                selected ? "border-primary/70 ring-1 ring-primary/40" : "border-border hover:border-muted-foreground/40",
                failed && !selected && "border-s-2 border-s-destructive/80",
                !step.enabled && "opacity-55",
              )}
            >
              <button
                type="button"
                data-flow-row={index}
                aria-current={selected ? "true" : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => onSelect(step.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusRow(Math.min(index + 1, steps.length - 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusRow(Math.max(index - 1, 0));
                  }
                }}
              >
                <span className="flex w-6 shrink-0 flex-col items-center gap-1">
                  <span className="font-mono text-[11px] text-muted-foreground">{n(index + 1)}</span>
                  <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {http ? (
                      <span className="shrink-0 font-mono text-[10px] font-semibold text-primary">{method}</span>
                    ) : ui ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-primary/40 px-1 text-[10px] font-semibold text-primary">
                        <MonitorPlay className="h-3 w-3" aria-hidden />
                        UI
                      </span>
                    ) : (
                      <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                        {label("stepType", step.type)}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-xs font-medium">{step.name}</span>
                  </span>
                  {http ? (
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground dir-ltr" dir="ltr" title={url}>
                      {url}
                    </span>
                  ) : ui ? (
                    <span className="mt-0.5 flex min-w-0 gap-1.5 text-[10px] text-muted-foreground">
                      <span className="truncate font-mono" dir="ltr" title={String(step.config.startUrl ?? "")}>
                        {String(step.config.startUrl ?? "")}
                      </span>
                      <span className="shrink-0">· {t("uiStep.actionCount", { count: n(uiCount) })}</span>
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10px]">
                  <span className={cn("font-medium", tone.text)}>{label("status", state)}</span>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    {typeof output?.status === "number" ? <span className="font-mono">{output.status}</span> : null}
                    {stepRun?.durationMs ? <span>{t("builder.flow.ms", { value: n(stepRun.durationMs) })}</span> : null}
                  </span>
                </span>
              </button>
              <span className="flex shrink-0 items-center gap-1">
                {http && typeof step.config.originalCurl === "string" ? (
                  <span className="hidden rounded border border-border px-1 text-[9px] uppercase text-muted-foreground sm:inline">
                    {t("builder.flow.curl")}
                  </span>
                ) : null}
                {sources.length > 0 ? (
                  <span
                    className="inline-flex items-center gap-0.5 rounded border border-primary/30 px-1 text-[10px] text-primary"
                    title={t("builder.flow.usesFrom", { steps: sources.map((item) => n(item)).join(", ") })}
                  >
                    <Link2 className="h-3 w-3" aria-hidden />
                    <span className="sr-only">{t("builder.flow.usesFrom", { steps: sources.map((item) => n(item)).join(", ") })}</span>
                    <span aria-hidden>{sources.map((item) => n(item)).join(",")}</span>
                  </span>
                ) : null}
                {broken ? (
                  <span title={t("builder.flow.needsReview")}>
                    <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-label={t("builder.flow.needsReview")} />
                  </span>
                ) : null}
                <Menu
                  label={t("builder.flow.actions")}
                  items={[
                    { label: t("builder.flow.runUntil"), icon: <Play className="h-3.5 w-3.5" />, disabled: busy, onSelect: () => onRunUntil(step) },
                    ...(ui ? [{ label: t("builder.flow.rerecord"), icon: <Video className="h-3.5 w-3.5" />, disabled: busy, onSelect: () => onRerecord(step) }] : []),
                    { label: t("builder.flow.moveUp"), icon: <ArrowUp className="h-3.5 w-3.5" />, disabled: index === 0 || busy, onSelect: () => onMove(step, -1) },
                    {
                      label: t("builder.flow.moveDown"),
                      icon: <ArrowDown className="h-3.5 w-3.5" />,
                      disabled: index === steps.length - 1 || busy,
                      onSelect: () => onMove(step, 1),
                    },
                    { label: t("builder.flow.duplicate"), icon: <Copy className="h-3.5 w-3.5" />, disabled: busy, onSelect: () => onDuplicate(step) },
                    {
                      label: step.enabled ? t("builder.flow.disable") : t("builder.flow.enable"),
                      icon: <Power className="h-3.5 w-3.5" />,
                      disabled: busy,
                      onSelect: () => onToggle(step),
                    },
                    { label: t("builder.flow.delete"), icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, disabled: busy, onSelect: () => onDelete(step) },
                  ]}
                />
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
