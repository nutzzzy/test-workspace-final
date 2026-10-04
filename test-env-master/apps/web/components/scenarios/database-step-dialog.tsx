"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DatabaseStepForm,
  EMPTY_DATABASE_STEP,
  databaseStepConfig,
  databaseStepProblem,
  type ConnectorChoice,
} from "@/components/scenarios/database-step-form";
import { useI18n } from "@/lib/i18n";

/**
 * A database step is created only once it has a connector and a valid query:
 * the API validates both, so an empty step cannot be saved and filled later.
 */
export function DatabaseStepDialog({
  connectors,
  onClose,
  onCreate,
}: {
  connectors: ConnectorChoice[];
  onClose: () => void;
  onCreate: (name: string, config: Record<string, unknown>) => Promise<void>;
}) {
  const { t, label, err } = useI18n();
  const active = connectors.filter((item) => item.status === "ACTIVE");
  const [name, setName] = useState("");
  const [value, setValue] = useState({ ...EMPTY_DATABASE_STEP, connectorId: active.length === 1 ? active[0]!.id : "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connector = connectors.find((item) => item.id === value.connectorId);
  const problem = databaseStepProblem(value, connector?.type);
  const ready = Boolean(value.connectorId) && !problem;

  return (
    <Dialog
      open
      title={t("dbStep.title")}
      description={t("dbStep.hint")}
      closeLabel={t("builder.panel.close")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onCreate(name.trim() || label("stepType", "DATABASE_ACTION"), databaseStepConfig(value))
                .then(onClose)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : "Request failed"))
                .finally(() => setBusy(false));
            }}
          >
            {t("dbStep.create")}
          </Button>
        </>
      }
    >
      {active.length === 0 ? (
        <p className="rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs text-warning">
          {connectors.length === 0 ? t("dbStep.noConnectors") : t("dbStep.noActiveConnectors")}{" "}
          <Link href="/settings" className="text-primary hover:underline">
            {t("dbStep.openSettings")}
          </Link>
        </p>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("builder.settings.name")}</span>
            <input
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={name}
              placeholder={label("stepType", "DATABASE_ACTION")}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <DatabaseStepForm connectors={connectors} value={value} onChange={setValue} />
          {!value.connectorId ? <p className="text-[11px] text-muted-foreground">{t("dbStep.chooseConnector")}</p> : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {err(error)}
        </p>
      ) : null}
    </Dialog>
  );
}
