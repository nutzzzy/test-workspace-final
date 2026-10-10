"use client";

import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ResponseExplorer, typeOf, type ResponsePick } from "@/components/scenarios/response-explorer";
import {
  outputOf,
  shortPath,
  type InputField,
  type InputLocation,
  type Step,
  type StepBinding,
  type StepRun,
} from "@/components/scenarios/builder-types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type PickerRequest = {
  /** The step whose field is filled; when absent the user chooses a later step. */
  consumerId?: string;
  target?: { location: InputLocation; field: string; key?: string };
  /** Start from a value of this step (Response tab → "Use in a later request"). */
  source?: { stepId: string; path: string };
};

const LOCATIONS: InputLocation[] = ["header", "query", "path", "body", "form", "cookie"];
const select = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";

/**
 * Choose a field of a request and a value from an earlier response. Only the
 * value's location is saved (as a mapping on the step); the value itself is
 * read again on every run.
 */
export function ValuePicker({
  request,
  steps,
  fieldsOf,
  runOf,
  onClose,
  onSave,
}: {
  request: PickerRequest;
  steps: Step[];
  fieldsOf: (stepId: string) => InputField[];
  runOf: (stepId: string) => StepRun | undefined;
  onClose: () => void;
  onSave: (stepId: string, binding: StepBinding, runAfter: boolean) => Promise<void>;
}) {
  const { t, n } = useI18n();
  const http = steps.filter((step) => step.type === "HTTP_REQUEST");
  const position = (id: string) => steps.findIndex((step) => step.id === id);
  const sourcePosition = request.source ? position(request.source.stepId) : -1;
  const consumers = http.filter((step) => position(step.id) > sourcePosition);

  const [consumerId, setConsumerId] = useState(request.consumerId ?? consumers[0]?.id ?? "");
  const fields = useMemo(() => (consumerId ? fieldsOf(consumerId) : []), [consumerId, fieldsOf]);
  const presetIndex = request.target
    ? fields.findIndex((field) => field.location === request.target!.location && field.field === request.target!.field)
    : -1;
  const [fieldChoice, setFieldChoice] = useState<string>(
    presetIndex >= 0 ? String(presetIndex) : request.target ? "other" : "",
  );
  const [custom, setCustom] = useState<{ location: InputLocation; field: string }>({
    location: request.target?.location ?? "header",
    field: request.target?.field ?? "",
  });

  const producers = http.filter((step) => position(step.id) < position(consumerId));
  const defaultProducer =
    request.source?.stepId ??
    [...producers].reverse().find((step) => outputOf(runOf(step.id))?.body !== undefined)?.id ??
    producers[producers.length - 1]?.id ??
    "";
  const [producerId, setProducerId] = useState(defaultProducer);
  const [pick, setPick] = useState<ResponsePick | null>(
    request.source ? { path: request.source.path, label: shortPath(request.source.path), type: "string", value: undefined, secret: true } : null,
  );
  const [busy, setBusy] = useState(false);

  const producer = producers.find((step) => step.id === producerId) ?? null;
  const output = producer ? outputOf(runOf(producer.id)) : null;
  const chosenField: (InputField | { location: InputLocation; field: string; key: string; type?: undefined }) | null =
    fieldChoice === "other"
      ? custom.field.trim()
        ? { location: custom.location, field: custom.field.trim(), key: custom.field.trim() }
        : null
      : fieldChoice !== ""
        ? fields[Number(fieldChoice)] ?? null
        : null;

  const fieldLabel = (field: { location: InputLocation; key: string }) => `${t(`builder.picker.locations.${field.location}`)} · ${field.key}`;
  const typeWarning =
    chosenField?.type && pick && chosenField.location === "body" && pick.type !== chosenField.type
      ? t("builder.picker.typeWarning", {
          from: t(`builder.picker.types.${chosenField.type}`),
          to: t(`builder.picker.types.${pick.type}`),
        })
      : null;
  const ready = Boolean(consumerId && chosenField && producer && pick);

  const save = async (runAfter: boolean) => {
    if (!chosenField || !producer || !pick) return;
    setBusy(true);
    try {
      await onSave(
        consumerId,
        {
          target: { location: chosenField.location, field: chosenField.field, key: chosenField.key },
          source: { stepId: producer.id, stepName: producer.name, orderIndex: producer.orderIndex, path: pick.path },
          origin: "manual",
        },
        runAfter,
      );
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("builder.picker.title")}
      description={t("builder.picker.pathOnly")}
      closeLabel={t("builder.panel.close")}
      onClose={onClose}
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" disabled={!ready || busy} onClick={() => void save(true)}>
            {t("builder.picker.saveAndRun")}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void save(false)}>
            {t("builder.picker.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <section className="space-y-2" aria-labelledby="picker-field">
          <h3 id="picker-field" className="text-xs font-medium">
            {t("builder.picker.field")}
          </h3>
          {!request.consumerId ? (
            <label className="block">
              <span className="sr-only">{t("builder.panel.tabs.request")}</span>
              <select
                className={select}
                value={consumerId}
                onChange={(event) => {
                  setConsumerId(event.target.value);
                  setFieldChoice("");
                }}
              >
                {consumers.map((step) => (
                  <option key={step.id} value={step.id}>
                    {t("builder.flow.step", { n: n(position(step.id) + 1) })} · {step.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className="sr-only">{t("builder.picker.field")}</span>
            <select className={select} value={fieldChoice} onChange={(event) => setFieldChoice(event.target.value)}>
              <option value="">{t("builder.picker.chooseField")}</option>
              {fields.map((field, index) => (
                <option key={`${field.location}:${field.field}`} value={String(index)}>
                  {fieldLabel(field)} = {field.display}
                </option>
              ))}
              <option value="other">{t("builder.picker.otherField")}</option>
            </select>
          </label>
          {fieldChoice === "other" ? (
            <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2">
              <label>
                <span className="sr-only">{t("builder.picker.location")}</span>
                <select
                  className={select}
                  value={custom.location}
                  onChange={(event) => setCustom((current) => ({ ...current, location: event.target.value as InputLocation }))}
                >
                  {LOCATIONS.map((location) => (
                    <option key={location} value={location}>
                      {t(`builder.picker.locations.${location}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">{t("builder.picker.fieldName")}</span>
                <input
                  className={`${select} font-mono`}
                  dir="ltr"
                  value={custom.field}
                  placeholder={custom.location === "path" ? "2" : custom.location === "body" ? "data.user.id" : "X-User-Id"}
                  onChange={(event) => setCustom((current) => ({ ...current, field: event.target.value }))}
                />
              </label>
            </div>
          ) : null}
        </section>

        <section className="space-y-2" aria-labelledby="picker-source">
          <h3 id="picker-source" className="text-xs font-medium">
            {t("builder.picker.source")}
          </h3>
          {producers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("builder.picker.noEarlier")}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("builder.picker.chooseStep")}>
                {producers.map((step) => {
                  const ran = outputOf(runOf(step.id))?.body !== undefined;
                  return (
                    <button
                      key={step.id}
                      type="button"
                      role="tab"
                      aria-selected={producerId === step.id}
                      className={cn(
                        "max-w-56 truncate rounded-md border px-2 py-1 text-xs",
                        producerId === step.id ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:bg-accent",
                        !ran && "opacity-60",
                      )}
                      onClick={() => {
                        setProducerId(step.id);
                        setPick(null);
                      }}
                    >
                      {n(position(step.id) + 1)} · {step.name}
                    </button>
                  );
                })}
              </div>
              {output && (output.body !== undefined || output.headers) ? (
                <ResponseExplorer
                  body={output.body}
                  headers={output.headers}
                  selectedPath={pick?.path ?? null}
                  onSelect={setPick}
                  compact
                />
              ) : (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                  {t("builder.picker.notRun")}
                </p>
              )}
            </>
          )}
        </section>

        {chosenField && pick && producer ? (
          <section className="space-y-1 rounded-md border border-primary/40 bg-primary/5 px-3 py-2" aria-live="polite">
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("builder.picker.preview")}</h3>
            <p className="flex flex-wrap items-center gap-1 text-xs">
              <ArrowLeft className="h-3.5 w-3.5 text-primary rtl:rotate-180" />
              <span className="break-all">
                {t("builder.picker.willSend", {
                  field: fieldLabel(chosenField),
                  n: n(position(producer.id) + 1),
                  path: shortPath(pick.path),
                })}
              </span>
            </p>
            {pick.value !== undefined ? (
              <p className="break-all font-mono text-[11px] text-muted-foreground dir-ltr">
                {pick.secret ? "••••••" : JSON.stringify(pick.value)?.slice(0, 200)}
              </p>
            ) : null}
            {typeWarning ? <p className="text-[11px] text-warning">{typeWarning}</p> : null}
            {typeOf(pick.value) === "object" || typeOf(pick.value) === "array" ? (
              <p className="text-[11px] text-destructive">{t("builder.picker.objectWarning")}</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
