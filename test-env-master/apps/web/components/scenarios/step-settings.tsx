"use client";

import { useState } from "react";
import { CheckCircle2, Trash2, XCircle } from "lucide-react";
import { readMappings, validateMappings, type ResponseMapping } from "@qa-workbench/shared";
import { Button } from "@/components/ui/button";
import {
  DatabaseStepForm,
  databaseStepConfig,
  databaseStepFromConfig,
  databaseStepProblem,
  type ConnectorChoice,
} from "@/components/scenarios/database-step-form";
import { ResponseMappingEditor, type VariableProducer } from "@/components/scenarios/response-mapping-editor";
import type { Step, StepOutput } from "@/components/scenarios/builder-types";
import { useI18n } from "@/lib/i18n";

const input = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";

/** Keys the form edits (or the Data Mapping tab owns); the raw editor shows everything else. */
const FORM_KEYS = ["bindings", "extract", "recovery", "timeoutMs", "continueOnFailure"];

function omit(config: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key)));
}

function readStatuses(raw: unknown) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];
  return list.map(String).join(", ");
}

/** The Assertions tab: when the step counts as passed, and the checks of the last run. */
export function AssertionsTab({
  step,
  attached,
  output,
  onSaveExpected,
  onDeleteAssertion,
}: {
  step: Step;
  attached: Step[];
  output: StepOutput | null;
  onSaveExpected: (statuses: number[]) => Promise<void>;
  onDeleteAssertion: (step: Step) => void;
}) {
  const { t, label } = useI18n();
  const [expected, setExpected] = useState(readStatuses(step.config.expectedStatus));
  const parsed = expected
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const invalid = parsed.some((code) => !Number.isInteger(code) || code < 100 || code > 599);

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div>
          <h3 className="text-xs font-medium">{t("builder.assertions.title")}</h3>
          <p className="text-[11px] text-muted-foreground">{t("builder.assertions.hint")}</p>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) void onSaveExpected(parsed);
          }}
        >
          <label className="min-w-0 flex-1 space-y-1">
            <span className="text-[11px] text-muted-foreground">{t("builder.assertions.expectedStatus")}</span>
            <input
              className={`${input} font-mono`}
              dir="ltr"
              value={expected}
              placeholder={t("builder.assertions.expectedStatusHint")}
              aria-invalid={invalid}
              onChange={(event) => setExpected(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="secondary" disabled={invalid}>
            {t("builder.settings.save")}
          </Button>
        </form>
      </section>

      {output?.assertions?.length ? (
        <section className="space-y-1">
          <h3 className="text-xs font-medium">{t("builder.assertions.checks")}</h3>
          <ul className="space-y-1">
            {output.assertions.map((check, index) => (
              <li key={index} className="flex items-start gap-2 text-xs">
                {check.passed ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                )}
                <span className="font-mono dir-ltr">{check.label}</span>
                {check.error ? <span className="text-destructive">{check.error}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-1">
        <h3 className="text-xs font-medium">{t("builder.assertions.attached")}</h3>
        {attached.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("builder.assertions.none")}</p>
        ) : (
          <ul className="space-y-1">
            {attached.map((item) => (
              <li key={item.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono dir-ltr">
                  {String(item.config.kind ?? label("stepType", item.type))} {String(item.config.path ?? "")}
                  {item.config.expected !== undefined ? ` = ${JSON.stringify(item.config.expected)}` : ""}
                </span>
                <Button size="icon" variant="ghost" aria-label={t("builder.flow.delete")} onClick={() => onDeleteAssertion(item)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The Advanced tab: name, on/off, failure handling, retry policy, exported
 * variables and the raw configuration. Saved mappings are edited in the Data
 * Mapping tab and are kept as they are.
 */
export function StepSettings({
  step,
  connectors,
  producers,
  environmentKeys,
  stepNumber,
  sample,
  onSave,
}: {
  step: Step;
  connectors: ConnectorChoice[];
  producers: VariableProducer[];
  environmentKeys: string[];
  stepNumber: (producer: VariableProducer) => number;
  sample: { body?: unknown; headers?: Record<string, string> } | null;
  onSave: (patch: { name: string; enabled: boolean; config: Record<string, unknown> }) => Promise<void>;
}) {
  const { t } = useI18n();
  const http = step.type === "HTTP_REQUEST";
  const recovery = (step.config.recovery && typeof step.config.recovery === "object" ? step.config.recovery : {}) as Record<string, unknown>;
  const rest = omit(step.config, http ? FORM_KEYS : ["continueOnFailure"]);
  const [name, setName] = useState(step.name);
  const [enabled, setEnabled] = useState(step.enabled);
  const [continueOnFailure, setContinueOnFailure] = useState(step.config.continueOnFailure === true);
  const [timeoutMs, setTimeoutMs] = useState(String(step.config.timeoutMs ?? 15000));
  const [retries, setRetries] = useState(recovery.enabled !== false);
  const [maxAttempts, setMaxAttempts] = useState(String(recovery.maxAttempts ?? 10));
  const [idempotent, setIdempotent] = useState(recovery.idempotent === true);
  const [allowDataChanges, setAllowDataChanges] = useState(recovery.allowDataChanges === true);
  const [mappings, setMappings] = useState<ResponseMapping[]>(readMappings(step.config));
  const [db, setDb] = useState(databaseStepFromConfig(step.config));
  const [raw, setRaw] = useState(JSON.stringify(rest, null, 2));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  let rawConfig: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    rawConfig = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    rawConfig = null;
  }
  const attempts = Number(maxAttempts);
  const attemptsInvalid = !Number.isInteger(attempts) || attempts < 0 || attempts > 10;
  const connector = connectors.find((item) => item.id === db.connectorId);
  const dbProblem = step.type === "DATABASE_ACTION" ? databaseStepProblem(db, connector?.type) : null;
  const invalid = !rawConfig || (http && (attemptsInvalid || validateMappings(mappings).length > 0)) || Boolean(dbProblem);

  const submit = async () => {
    if (!rawConfig) return;
    let config: Record<string, unknown> = { ...rawConfig };
    if (http) {
      config = {
        ...config,
        timeoutMs: Number(timeoutMs) || 15000,
        continueOnFailure: continueOnFailure || undefined,
        recovery: { ...recovery, enabled: retries, maxAttempts: attempts, idempotent, allowDataChanges },
        ...(step.config.bindings !== undefined ? { bindings: step.config.bindings } : {}),
        ...(mappings.length ? { extract: mappings } : {}),
      };
    } else if (step.type === "DATABASE_ACTION") {
      config = { ...databaseStepConfig(db), continueOnFailure: continueOnFailure || undefined };
    } else {
      config = { ...config, continueOnFailure: continueOnFailure || undefined };
    }
    setBusy(true);
    try {
      await onSave({ name: name.trim() || step.name, enabled, config });
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onChange={() => setSaved(false)}
    >
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t("builder.settings.general")}</legend>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">{t("builder.settings.name")}</span>
          <input className={input} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          {t("builder.settings.enabled")}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={continueOnFailure} onChange={(event) => setContinueOnFailure(event.target.checked)} />
          {t("builder.settings.continueOnFailure")}
        </label>
        {http ? (
          <label className="block max-w-48 space-y-1">
            <span className="text-[11px] text-muted-foreground">{t("builder.settings.timeout")}</span>
            <input className={`${input} font-mono`} dir="ltr" inputMode="numeric" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
          </label>
        ) : null}
      </fieldset>

      {http ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">{t("builder.settings.retriesTitle")}</legend>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={retries} onChange={(event) => setRetries(event.target.checked)} />
            {t("builder.settings.retriesEnabled")}
          </label>
          <label className="block max-w-48 space-y-1">
            <span className="text-[11px] text-muted-foreground">{t("builder.settings.maxAttempts")}</span>
            <input
              className={`${input} font-mono`}
              dir="ltr"
              type="number"
              min={0}
              max={10}
              value={maxAttempts}
              disabled={!retries}
              aria-invalid={attemptsInvalid}
              onChange={(event) => setMaxAttempts(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={idempotent} disabled={!retries} onChange={(event) => setIdempotent(event.target.checked)} />
            {t("builder.settings.idempotent")}
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={allowDataChanges}
              disabled={!retries}
              onChange={(event) => setAllowDataChanges(event.target.checked)}
            />
            <span>
              {t("builder.settings.allowDataChanges")}
              <span className="block text-[11px] text-muted-foreground">{t("builder.settings.allowDataChangesHint")}</span>
            </span>
          </label>
        </fieldset>
      ) : null}

      {step.type === "DATABASE_ACTION" ? <DatabaseStepForm connectors={connectors} value={db} onChange={setDb} /> : null}

      {http ? (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t("builder.settings.exportVariables")}</summary>
          <div className="px-3 pb-3">
            <ResponseMappingEditor
              value={mappings}
              onChange={setMappings}
              sample={sample}
              otherProducers={producers.filter((producer) => producer.stepId !== step.id)}
              environmentKeys={environmentKeys}
              stepNumber={stepNumber}
            />
          </div>
        </details>
      ) : null}

      {step.type !== "DATABASE_ACTION" ? (
        <details className="rounded-md border border-border" open={!http}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t("builder.settings.rawConfig")}</summary>
          <div className="space-y-1 px-3 pb-3">
            <textarea
              className="min-h-40 w-full rounded-md border border-border bg-background p-2 font-mono text-[11px]"
              dir="ltr"
              value={raw}
              aria-invalid={!rawConfig}
              onChange={(event) => setRaw(event.target.value)}
            />
            {!rawConfig ? <p className="text-[11px] text-destructive">{t("builder.settings.invalidJson")}</p> : null}
          </div>
        </details>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {saved ? <span className="text-[11px] text-success" aria-live="polite">{t("builder.settings.saved")}</span> : null}
        <Button type="submit" disabled={busy || invalid}>
          {t("builder.settings.save")}
        </Button>
      </div>
    </form>
  );
}
