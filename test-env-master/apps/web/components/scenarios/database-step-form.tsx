"use client";

import { operationsForDatabase } from "@qa-workbench/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export type ConnectorChoice = {
  id: string;
  name: string;
  type: string;
  status: string;
};

export type DatabaseStepValue = {
  connectorId: string;
  operation: "QUERY" | "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ASSERTION";
  query: string;
  assertion: "" | "ROW_COUNT" | "CONTAINS";
  expected: string;
  inputs: Array<{ from: string; to: string }>;
  outputs: Array<{ from: string; to: string }>;
  continueOnFailure: boolean;
};

export const EMPTY_DATABASE_STEP: DatabaseStepValue = {
  connectorId: "",
  operation: "SELECT",
  query: "",
  assertion: "",
  expected: "",
  inputs: [],
  outputs: [],
  continueOnFailure: false,
};

const OPERATIONS = ["QUERY", "SELECT", "INSERT", "UPDATE", "DELETE", "ASSERTION"] as const;
const SQL_TYPES = new Set(["MYSQL", "POSTGRESQL", "SQLSERVER", "ORACLE"]);

function mappingObject(rows: Array<{ from: string; to: string }>) {
  return Object.fromEntries(
    rows.filter((row) => row.from.trim() && row.to.trim()).map((row) => [row.from.trim(), row.to.trim()]),
  );
}

function rowsFrom(value: unknown): Array<{ from: string; to: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([from, to]) => ({
    from,
    to: typeof to === "string" ? to : "",
  }));
}

export function databaseStepConfig(value: DatabaseStepValue) {
  return {
    connectorId: value.connectorId,
    operation: value.operation,
    query: value.query,
    assertion: value.operation === "ASSERTION" ? value.assertion || "ROW_COUNT" : value.assertion,
    expected: value.expected,
    inputMapping: mappingObject(value.inputs),
    outputMapping: mappingObject(value.outputs),
    continueOnFailure: value.continueOnFailure,
  };
}

export function databaseStepFromConfig(config: Record<string, unknown>): DatabaseStepValue {
  const operation = OPERATIONS.includes(config.operation as (typeof OPERATIONS)[number])
    ? (config.operation as DatabaseStepValue["operation"])
    : "SELECT";
  return {
    connectorId: typeof config.connectorId === "string" ? config.connectorId : "",
    operation,
    query: typeof config.query === "string" ? config.query : "",
    assertion:
      config.assertion === "ROW_COUNT" || config.assertion === "CONTAINS"
        ? config.assertion
        : "",
    expected: typeof config.expected === "string" ? config.expected : "",
    inputs: rowsFrom(config.inputMapping),
    outputs: rowsFrom(config.outputMapping),
    continueOnFailure: config.continueOnFailure === true,
  };
}

export function databaseStepProblem(
  value: DatabaseStepValue,
  connectorType?: string,
): string | null {
  if (!value.query.trim()) return "Query is empty";
  if (!SQL_TYPES.has(connectorType ?? "")) return null;
  if (/--|\/\*|#/.test(value.query)) return "Comments are not allowed in queries";
  const body = value.query.trim().replace(/;+\s*$/g, "");
  if (body.includes(";")) return "Only one statement is allowed";
  const keyword = (body.match(/^([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  const allowed: Record<string, string[]> = {
    SELECT: ["SELECT", "WITH"],
    INSERT: ["INSERT"],
    UPDATE: ["UPDATE"],
    DELETE: ["DELETE"],
    QUERY: ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE"],
    ASSERTION: ["SELECT", "WITH"],
  };
  if (!allowed[value.operation]?.includes(keyword)) {
    return "This operation does not allow that statement";
  }
  if (/\b(DROP|ALTER|TRUNCATE|CREATE|EXEC|EXECUTE)\b/i.test(body)) {
    return "Statement is not allowed";
  }
  return null;
}

export function DatabaseStepForm({
  connectors,
  value,
  onChange,
}: {
  connectors: ConnectorChoice[];
  value: DatabaseStepValue;
  onChange: (value: DatabaseStepValue) => void;
}) {
  const { t, err } = useI18n();
  const selected = connectors.find((item) => item.id === value.connectorId);
  const operations = operationsForDatabase(selected?.type || "POSTGRESQL");
  const problem = value.query.trim() ? databaseStepProblem(value, selected?.type) : null;

  const updateRow = (
    key: "inputs" | "outputs",
    index: number,
    field: "from" | "to",
    next: string,
  ) => {
    const rows = value[key].map((row, rowIndex) =>
      rowIndex === index ? { ...row, [field]: next } : row,
    );
    onChange({ ...value, [key]: rows });
  };

  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">{t("connectors.select")}</span>
        <select
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          value={value.connectorId}
          onChange={(e) => {
            const connectorId = e.target.value;
            const nextType = connectors.find((item) => item.id === connectorId)?.type ?? "";
            const allowed = operationsForDatabase(nextType);
            onChange({
              ...value,
              connectorId,
              operation: allowed.includes(value.operation) ? value.operation : allowed[0] ?? "QUERY",
            });
          }}
        >
          <option value="">{t("connectors.select")}</option>
          {connectors.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.type}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">{t("connectors.operation")}</span>
        <select
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          value={value.operation}
          onChange={(e) =>
            onChange({
              ...value,
              operation: e.target.value as DatabaseStepValue["operation"],
            })
          }
        >
          {operations.map((operation) => (
            <option key={operation} value={operation}>
              {t(`connectors.operations.${operation}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">{t("connectors.query")}</span>
        <textarea
          className="min-h-24 w-full rounded-md border border-border bg-background p-2 font-mono text-xs dir-ltr"
          dir="ltr"
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
        />
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("connectors.assertion")}</span>
          <select
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={value.operation === "ASSERTION" ? value.assertion || "ROW_COUNT" : value.assertion}
            onChange={(e) =>
              onChange({
                ...value,
                assertion: e.target.value as DatabaseStepValue["assertion"],
              })
            }
          >
            {value.operation === "ASSERTION" ? null : (
              <option value="">{t("connectors.assertionNone")}</option>
            )}
            <option value="ROW_COUNT">{t("connectors.rowCount")}</option>
            <option value="CONTAINS">{t("connectors.contains")}</option>
          </select>
        </label>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("connectors.expected")}</span>
          <input
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm dir-ltr"
            dir="ltr"
            value={value.expected}
            onChange={(e) => onChange({ ...value, expected: e.target.value })}
          />
        </label>
      </div>
      <MappingEditor
        title={t("connectors.input")}
        fromHint={t("connectors.inputHint")}
        toHint={t("connectors.sourceHint")}
        addLabel={t("connectors.addInput")}
        rows={value.inputs}
        onAdd={() => onChange({ ...value, inputs: [...value.inputs, { from: "", to: "" }] })}
        onChange={(index, field, next) => updateRow("inputs", index, field, next)}
      />
      <MappingEditor
        title={t("connectors.output")}
        fromHint={t("connectors.outputHint")}
        toHint={t("connectors.pathHint")}
        addLabel={t("connectors.addOutput")}
        rows={value.outputs}
        onAdd={() => onChange({ ...value, outputs: [...value.outputs, { from: "", to: "" }] })}
        onChange={(index, field, next) => updateRow("outputs", index, field, next)}
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={value.continueOnFailure}
          onChange={(e) => onChange({ ...value, continueOnFailure: e.target.checked })}
        />
        {t("connectors.continue")}
      </label>
      {problem ? <p className="text-xs text-destructive">{err(problem)}</p> : null}
    </div>
  );
}

function MappingEditor({
  title,
  fromHint,
  toHint,
  addLabel,
  rows,
  onAdd,
  onChange,
}: {
  title: string;
  fromHint: string;
  toHint: string;
  addLabel: string;
  rows: Array<{ from: string; to: string }>;
  onAdd: () => void;
  onChange: (index: number, field: "from" | "to", value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{title}</div>
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-2 gap-1">
          <input
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs dir-ltr"
            dir="ltr"
            placeholder={fromHint}
            value={row.from}
            onChange={(e) => onChange(index, "from", e.target.value)}
          />
          <input
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs dir-ltr"
            dir="ltr"
            placeholder={toHint}
            value={row.to}
            onChange={(e) => onChange(index, "to", e.target.value)}
          />
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={onAdd}>
        {addLabel}
      </Button>
    </div>
  );
}
