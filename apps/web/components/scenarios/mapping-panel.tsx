"use client";

import { AlertTriangle, ArrowLeft, Check, Link2, Plus, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isResponseSource,
  NEEDS_REVIEW,
  shortPath,
  type InputField,
  type MappingReview,
  type MappingStatus,
  type ResponseSource,
  type StepBinding,
  type Suggestion,
} from "@/components/scenarios/builder-types";
import type { PickerRequest } from "@/components/scenarios/value-picker";
import { ListPickEditor, pickPath, splitListPath, type ListPickHelp } from "@/components/scenarios/list-pick-editor";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<MappingStatus, string> = {
  ok: "text-success border-success/40",
  unverified: "text-muted-foreground border-border",
  disabled: "text-muted-foreground border-border",
  source_missing: "text-warning border-warning/50",
  source_after_target: "text-warning border-warning/50",
  source_disabled: "text-warning border-warning/50",
  target_missing: "text-warning border-warning/50",
  path_missing: "text-warning border-warning/50",
};

/** "Header · Authorization", "URL path · userId" */
export function useTargetLabel(fields: InputField[]) {
  const { t } = useI18n();
  return (target: StepBinding["target"]) => {
    const key =
      target.key ??
      fields.find((field) => field.location === target.location && field.field === target.field)?.key ??
      target.field;
    return `${t(`builder.picker.locations.${target.location}`)} · ${key}`;
  };
}

/** One line that says where a suggestion's value comes from. */
export function useSuggestionSource() {
  const { t, n } = useI18n();
  return (suggestion: Suggestion, stepNumber: number) => {
    const where = suggestion.sourcePath
      ? shortPath(suggestion.sourcePath)
      : suggestion.expect?.kind === "token"
        ? t("builder.detected.sourceToken")
        : t("builder.detected.sourceKey", { key: suggestion.expect?.key ?? "" });
    return `${t("builder.flow.step", { n: n(stepNumber) })} · ${where}`;
  };
}

export function SuggestionRow({
  suggestion,
  producerNumber,
  consumerNumber,
  targetLabel,
  onAccept,
  onDismiss,
  showConsumer,
}: {
  suggestion: Suggestion;
  producerNumber: number;
  consumerNumber: number;
  targetLabel: string;
  onAccept: () => void;
  onDismiss: () => void;
  showConsumer?: boolean;
}) {
  const { t, n } = useI18n();
  const source = useSuggestionSource();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          {showConsumer ? (
            <span className="text-muted-foreground">{t("builder.flow.step", { n: n(consumerNumber) })} ·</span>
          ) : null}
          <span className="font-medium">{targetLabel}</span>
          <ArrowLeft className="h-3 w-3 text-muted-foreground rtl:rotate-180" />
          <span className="break-all">{source(suggestion, producerNumber)}</span>
        </p>
        <p className="text-[11px] text-muted-foreground">
          <span
            className={cn(
              suggestion.confidence === "HIGH" ? "text-success" : suggestion.confidence === "MEDIUM" ? "text-primary" : "text-warning",
            )}
          >
            {t(`builder.detected.confidence.${suggestion.confidence}`)}
          </span>
          {" · "}
          {t(`builder.detected.reasons.${suggestion.reason}`)}
          {" · "}
          {suggestion.evidence === "response" ? t("builder.detected.verified") : t("builder.detected.inferred")}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t("builder.detected.dismiss")}
        </Button>
        <Button size="sm" variant="secondary" onClick={onAccept}>
          <Check className="h-3.5 w-3.5" />
          {t("builder.detected.accept")}
        </Button>
      </div>
    </li>
  );
}

/** The Data Mapping tab: saved mappings of one step, their health, and suggestions. */
export function MappingPanel({
  stepId,
  reviews,
  suggestions,
  fields,
  stepNumber,
  onPick,
  onToggle,
  onRemove,
  onAccept,
  onDismiss,
  onAutoMap,
  onListPickHelp,
  onSaveBinding,
}: {
  stepId: string;
  reviews: MappingReview[];
  suggestions: Suggestion[];
  fields: InputField[];
  stepNumber: (id: string | undefined) => number;
  onPick: (request: PickerRequest) => void;
  onToggle: (binding: StepBinding) => void;
  onRemove: (binding: StepBinding) => void;
  onAccept: (suggestion: Suggestion) => void;
  onDismiss: (suggestion: Suggestion) => void;
  onAutoMap: () => void;
  /** The list a mapping reads and conditions that recognise its item. */
  onListPickHelp: (source: ResponseSource) => Promise<ListPickHelp>;
  onSaveBinding: (binding: StepBinding) => Promise<void>;
}) {
  const { t, n } = useI18n();
  const targetLabel = useTargetLabel(fields);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-medium">{t("builder.mapping.title")}</h3>
          <p className="text-[11px] text-muted-foreground">{t("builder.mapping.hint")}</p>
        </div>
        <span className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" title={t("builder.autoMap.hint")} onClick={onAutoMap}>
            <Wand2 className="h-3.5 w-3.5" />
            {t("builder.autoMap.button")}
          </Button>
          <Button size="sm" onClick={() => onPick({ consumerId: stepId })}>
            <Plus className="h-3.5 w-3.5" />
            {t("builder.mapping.add")}
          </Button>
        </span>
      </div>

      {reviews.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("builder.mapping.none")}
        </p>
      ) : (
        <ul className="space-y-2">
          {reviews.map((review) => {
            const { binding } = review;
            const broken = NEEDS_REVIEW.includes(review.status);
            const source = binding.source;
            const from = isResponseSource(source)
              ? source.path
                ? t("builder.mapping.source", { n: n(review.sourceStep ?? stepNumber(source.stepId)), path: source.pick ? pickPath(source.path, source.pick) : shortPath(source.path) })
                : t("builder.mapping.sourceExpected", { n: n(review.sourceStep ?? stepNumber(source.stepId)), key: source.expect?.key ?? "" })
              : `${t("builder.mapping.fixedValue")}: ${source.value}`;
            return (
              <li
                key={`${binding.target.location}:${binding.target.field}`}
                className={cn("space-y-1.5 rounded-md border px-3 py-2", broken ? "border-warning/50 bg-warning/5" : "border-border")}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="text-xs font-medium">{targetLabel(binding.target)}</span>
                  <ArrowLeft className="h-3 w-3 text-muted-foreground rtl:rotate-180" />
                  <span className={cn("min-w-0 break-all text-xs", binding.enabled === false && "text-muted-foreground line-through")}>
                    {from}
                  </span>
                  <span className={cn("ms-auto rounded border px-1.5 py-0.5 text-[10px]", STATUS_TONE[review.status])}>
                    {broken ? <AlertTriangle className="me-1 inline h-3 w-3" /> : null}
                    {t(`builder.mapping.statusLabels.${review.status}`)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {binding.origin === "accepted" ? t("builder.mapping.accepted") : t("builder.mapping.manual")}
                    {broken ? ` · ${t("builder.mapping.reviewHint")}` : ""}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant={broken ? "secondary" : "ghost"}
                      onClick={() => onPick({ consumerId: stepId, target: binding.target })}
                    >
                      {t("builder.mapping.change")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onToggle(binding)}>
                      {binding.enabled === false ? t("builder.mapping.enable") : t("builder.mapping.disable")}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onRemove(binding)}>
                      {t("builder.mapping.remove")}
                    </Button>
                  </span>
                </div>
                {isResponseSource(source) && source.path && splitListPath(source.path) ? (
                  <ListPickEditor
                    binding={{ ...binding, source }}
                    load={() => onListPickHelp(source)}
                    onSave={onSaveBinding}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {suggestions.length > 0 ? (
        <section className="space-y-2" aria-labelledby="mapping-suggestions">
          <h3 id="mapping-suggestions" className="text-xs font-medium">
            {t("builder.mapping.suggestionsTitle")}
          </h3>
          <ul className="space-y-2">
            {suggestions.map((suggestion) => (
              <SuggestionRow
                key={suggestion.id}
                suggestion={suggestion}
                producerNumber={stepNumber(suggestion.producerStepId)}
                consumerNumber={stepNumber(suggestion.consumerStepId)}
                targetLabel={targetLabel(suggestion.target)}
                onAccept={() => onAccept(suggestion)}
                onDismiss={() => onDismiss(suggestion)}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
