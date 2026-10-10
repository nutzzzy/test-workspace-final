"use client";

import { AlertOctagon, Link2 } from "lucide-react";
import { BidiText } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { InputField, ResponseError } from "@/components/scenarios/builder-types";
import type { PickerRequest } from "@/components/scenarios/value-picker";
import { useTargetLabel } from "@/components/scenarios/mapping-panel";

/**
 * What the response said was wrong — also when the status was 2xx — and the
 * request field and mapping it is about, with the way to fix that mapping.
 */
export function ResponseErrorCard({
  error,
  stepId,
  fields,
  onPick,
}: {
  error: ResponseError;
  stepId: string;
  fields: InputField[];
  onPick: (request: PickerRequest) => void;
}) {
  const { t, n } = useI18n();
  const targetLabel = useTargetLabel(fields);
  const { field, mapping } = error;
  return (
    <section className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2" aria-labelledby={`response-error-${stepId}`}>
      <h3 id={`response-error-${stepId}`} className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertOctagon className="h-3.5 w-3.5 shrink-0" />
        {t("builder.responseError.title")}
      </h3>
      <BidiText text={error.message} className="block text-xs" />
      <p className="text-[11px] text-muted-foreground">
        {t("builder.responseError.signal")}: <span className="font-mono" dir="ltr">{error.signal}</span>
        {error.code ? (
          <>
            {" · "}
            {t("builder.responseError.code")}: <span className="font-mono" dir="ltr">{error.code}</span>
          </>
        ) : null}
      </p>
      {field ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-destructive/20 pt-1.5 text-[11px]">
          <Link2 className="h-3 w-3 shrink-0 text-primary" />
          <span>
            {t(`builder.responseError.about.${error.fieldEvidence ?? "mentioned"}`, { field: targetLabel(field) })}
            {" — "}
            {mapping
              ? mapping.fixedValue
                ? t("builder.responseError.fixedValue")
                : t("builder.responseError.mappedFrom", { n: n((mapping.orderIndex ?? 0) + 1), path: mapping.path ?? "" })
              : t("builder.responseError.notMapped")}
          </span>
          <Button size="sm" variant="secondary" className="ms-auto" onClick={() => onPick({ consumerId: stepId, target: field })}>
            {mapping ? t("builder.responseError.changeMapping") : t("builder.responseError.mapIt")}
          </Button>
        </div>
      ) : (
        <p className="border-t border-destructive/20 pt-1.5 text-[11px] text-muted-foreground">{t("builder.responseError.noField")}</p>
      )}
    </section>
  );
}
