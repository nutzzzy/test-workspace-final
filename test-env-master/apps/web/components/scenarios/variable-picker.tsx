"use client";

import { findVariableRefs } from "@qa-workbench/shared";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { VariableProducer } from "@/components/scenarios/response-mapping-editor";

/**
 * Variables a step can use: environment keys and values produced by earlier
 * steps (available), and values of later steps (shown, not insertable). Also
 * warns about {{references}} in the step's template that nothing defines.
 */
export function VariablePicker({
  producers,
  environmentKeys,
  position,
  stepNumber,
  template,
  onInsert,
}: {
  producers: VariableProducer[];
  environmentKeys: string[];
  /** orderIndex of the step being edited; a new step runs after all others. */
  position: number;
  stepNumber: (producer: VariableProducer) => number;
  /** The step's current request text (JSON or cURL), checked for references. */
  template: string;
  onInsert: (name: string) => void;
}) {
  const { t, n } = useI18n();
  const earlier = new Map<string, VariableProducer>();
  for (const producer of producers) if (producer.orderIndex < position) earlier.set(producer.name, producer);
  const later = producers.filter(
    (producer) => producer.orderIndex >= position && !earlier.has(producer.name) && !environmentKeys.includes(producer.name),
  );
  const laterNames = new Map(later.map((producer) => [producer.name, producer]));

  const refs = findVariableRefs(template);
  const usedEarly = refs.filter((name) => laterNames.has(name) && !environmentKeys.includes(name));
  const unknown = refs.filter((name) => !earlier.has(name) && !environmentKeys.includes(name) && !laterNames.has(name));

  const chip = "inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]";

  return (
    <section className="space-y-1.5 rounded-md border border-border px-2 py-2" aria-labelledby="variable-picker-title">
      <div>
        <h3 id="variable-picker-title" className="text-xs font-medium">
          {t("scenarios.variables.title")}
        </h3>
        <p className="text-[11px] text-muted-foreground">{t("scenarios.variables.hint")}</p>
      </div>
      {earlier.size === 0 && environmentKeys.length === 0 && later.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("scenarios.variables.none")}</p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {[...earlier.values()].map((producer) => (
          <button
            key={`step-${producer.name}`}
            type="button"
            onClick={() => onInsert(producer.name)}
            className={cn(chip, "border-primary/40 text-primary hover:bg-primary/10")}
            title={producer.path ? `${producer.from ?? "body"} ${producer.path}` : undefined}
          >
            <span className="dir-ltr font-mono">{`{{${producer.name}}}`}</span>
            <span className="text-muted-foreground">
              {t("scenarios.variables.fromStep", { n: n(stepNumber(producer)), name: producer.stepName })}
            </span>
            {producer.secret ? <span className="text-warning">· {t("scenarios.variables.secret")}</span> : null}
          </button>
        ))}
        {environmentKeys
          .filter((key) => !earlier.has(key))
          .map((key) => (
            <button
              key={`env-${key}`}
              type="button"
              onClick={() => onInsert(key)}
              className={cn(chip, "border-border hover:bg-accent")}
            >
              <span className="dir-ltr font-mono">{`{{${key}}}`}</span>
              <span className="text-muted-foreground">{t("scenarios.variables.environment")}</span>
            </button>
          ))}
        {later.map((producer) => (
          <span
            key={`later-${producer.name}`}
            aria-disabled="true"
            className={cn(chip, "cursor-not-allowed border-dashed border-border text-muted-foreground opacity-70")}
          >
            <span className="dir-ltr font-mono">{`{{${producer.name}}}`}</span>
            <span>{t("scenarios.variables.later", { n: n(stepNumber(producer)) })}</span>
          </span>
        ))}
      </div>
      {usedEarly.map((name) => (
        <p key={`early-${name}`} role="alert" className="text-[11px] text-destructive">
          {t("scenarios.variables.usedEarly", { name: `{{${name}}}`, n: n(stepNumber(laterNames.get(name)!)) })}
        </p>
      ))}
      {unknown.length > 0 ? (
        <p className="text-[11px] text-warning">
          {t("scenarios.variables.unresolved", { names: unknown.map((name) => `{{${name}}}`).join(", ") })}
        </p>
      ) : null}
    </section>
  );
}
