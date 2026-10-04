"use client";

import { validateMappings, type ResponseMapping, type ResponseMappingSource } from "@qa-workbench/shared";
import { Button } from "@/components/ui/button";
import { ResponseExplorer } from "@/components/scenarios/response-explorer";
import { useI18n } from "@/lib/i18n";

export type VariableProducer = {
  name: string;
  stepId?: string;
  stepName: string;
  orderIndex: number;
  kind: "mapping" | "extract_step" | "set_step" | "database";
  from?: ResponseMappingSource;
  path?: string;
  optional?: boolean;
  secret?: boolean;
};

const SOURCES: ResponseMappingSource[] = ["body", "header", "status"];

/** A variable name suggested from the last path segment ($.data.user.id → userId). */
export function suggestVariable(path: string, taken: string[]) {
  const segments = [...path.matchAll(/\['((?:\\.|[^'])*)'\]|\.([^.[\]]+)/g)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((segment) => segment && !/^\d+$/.test(segment));
  const leaf = segments[segments.length - 1] ?? "value";
  const parent = segments[segments.length - 2];
  const raw = /^id$/i.test(leaf) && parent ? `${parent.replace(/s$/, "")}Id` : leaf;
  let base = raw.replace(/[^A-Za-z0-9_]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""));
  if (!/^[A-Za-z_]/.test(base)) base = `v${base}`;
  let name = base;
  for (let n = 2; taken.includes(name); n += 1) name = `${base}${n}`;
  return name;
}

const input = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";

/** Edit the response mappings (`config.extract`) of one HTTP step. */
export function ResponseMappingEditor({
  value,
  onChange,
  sample,
  otherProducers,
  environmentKeys,
  stepNumber,
}: {
  value: ResponseMapping[];
  onChange: (next: ResponseMapping[]) => void;
  /** Latest response of this step, when the scenario has run. */
  sample?: { body?: unknown; headers?: Record<string, string> } | null;
  /** Variables other steps produce (for conflict hints). */
  otherProducers: VariableProducer[];
  environmentKeys: string[];
  stepNumber: (producer: VariableProducer) => number;
}) {
  const { t, n } = useI18n();
  const problems = validateMappings(value);
  const update = (index: number, patch: Partial<ResponseMapping>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const add = (row: Partial<ResponseMapping> = {}) =>
    onChange([
      ...value,
      {
        variable: row.variable ?? "",
        path: row.path ?? "",
        from: row.from ?? "body",
      },
    ]);
  const taken = value.map((row) => row.variable);

  return (
    <section className="space-y-2 rounded-md border border-border px-2 py-2" aria-labelledby="response-mapping-title">
      <div>
        <h3 id="response-mapping-title" className="text-xs font-medium">
          {t("scenarios.mapping.title")}
        </h3>
        <p className="text-[11px] text-muted-foreground">{t("scenarios.mapping.hint")}</p>
      </div>

      {value.map((row, index) => {
        const from = row.from ?? "body";
        const rowProblems = problems.filter((problem) => problem.index === index);
        const elsewhere = otherProducers.find((producer) => producer.name === row.variable);
        return (
          <div key={index} className="space-y-1 border-s-2 border-border ps-2">
            <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,1.4fr)_auto]">
              <label className="min-w-0">
                <span className="sr-only">{t("scenarios.mapping.variable")}</span>
                <input
                  className={`${input} font-mono`}
                  dir="ltr"
                  value={row.variable}
                  placeholder={t("scenarios.mapping.variable")}
                  aria-invalid={rowProblems.some((p) => p.code === "invalid_name" || p.code === "duplicate_name")}
                  onChange={(event) => update(index, { variable: event.target.value.trim() })}
                />
              </label>
              <label className="min-w-0">
                <span className="sr-only">{t("scenarios.mapping.source")}</span>
                <select
                  className={input}
                  value={from}
                  onChange={(event) => update(index, { from: event.target.value as ResponseMappingSource })}
                >
                  {SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {t(`scenarios.mapping.sources.${source}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className="sr-only">{t("scenarios.mapping.path")}</span>
                <input
                  className={`${input} font-mono`}
                  dir="ltr"
                  value={from === "status" ? "" : row.path}
                  disabled={from === "status"}
                  placeholder={from === "header" ? "X-Request-Id" : "$.data.user.id"}
                  aria-invalid={rowProblems.some((p) => p.code === "invalid_path" || p.code === "invalid_header")}
                  onChange={(event) => update(index, { path: event.target.value })}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                aria-label={`${t("scenarios.mapping.remove")} ${row.variable}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                {t("scenarios.mapping.remove")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <label className="flex items-center gap-1" title={t("scenarios.mapping.optionalHint")}>
                <input
                  type="checkbox"
                  checked={row.optional === true}
                  onChange={(event) => update(index, { optional: event.target.checked || undefined })}
                />
                {t("scenarios.mapping.optional")}
              </label>
              <label className="flex items-center gap-1" title={t("scenarios.mapping.secretHint")}>
                <input
                  type="checkbox"
                  checked={row.secret === true}
                  onChange={(event) => update(index, { secret: event.target.checked || undefined })}
                />
                {t("scenarios.mapping.secret")}
              </label>
            </div>
            {rowProblems.map((problem) => (
              <p key={problem.code} role="alert" className="text-[11px] text-destructive">
                {t(`scenarios.mapping.problems.${problem.code}`, { detail: problem.detail })}
              </p>
            ))}
            {row.variable && environmentKeys.includes(row.variable) ? (
              <p className="text-[11px] text-warning">{t("scenarios.mapping.conflictEnv")}</p>
            ) : null}
            {row.variable && elsewhere ? (
              <p className="text-[11px] text-warning">
                {t("scenarios.mapping.conflictStep", { n: n(stepNumber(elsewhere)), name: elsewhere.stepName })}
              </p>
            ) : null}
          </div>
        );
      })}

      <Button size="sm" variant="outline" onClick={() => add()}>
        {t("scenarios.mapping.add")}
      </Button>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t("scenarios.mapping.pickFromResponse")}</summary>
        {sample && (sample.body !== undefined || sample.headers) ? (
          <div className="mt-1">
            <ResponseExplorer
              body={sample.body}
              headers={sample.headers}
              compact
              onSelect={(pick) => {
                const header = pick.path.startsWith("response.headers.");
                const path = header ? pick.path.slice("response.headers.".length) : pick.label;
                add({ path, variable: suggestVariable(header ? `.${path}` : pick.label, taken), from: header ? "header" : "body" });
              }}
            />
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-muted-foreground">{t("scenarios.mapping.noSample")}</p>
        )}
      </details>
    </section>
  );
}
