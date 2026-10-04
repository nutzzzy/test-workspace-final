"use client";

import { useState } from "react";
import { AlertTriangle, ArrowLeft, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { Suggestion } from "@/components/scenarios/builder-types";
import { useSuggestionSource } from "@/components/scenarios/mapping-panel";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type ImportItem =
  | {
      index: number;
      ok: true;
      name: string;
      method: string;
      url: string;
      headers: Record<string, string>;
      query: string[];
      body: "none" | "json" | "form" | "text";
      warnings: Array<{ code: string; detail: string }>;
    }
  | { index: number; ok: false; code: string; preview: string };

type Preview = { items: ImportItem[]; dependencies: Suggestion[] };

/**
 * Paste several cURL commands, review what will be created (warnings,
 * malformed commands, detected connections) and import. Nothing runs.
 */
export function CurlImportDialog({
  scenarioId,
  existingIds,
  onClose,
  onImported,
}: {
  scenarioId: string;
  /** Current steps in order, so connections from them show their step number. */
  existingIds: string[];
  onClose: () => void;
  onImported: (result: { imported: number; firstStepIndex: number }) => Promise<void>;
}) {
  const { t, n, err } = useI18n();
  const source = useSuggestionSource();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = preview?.items.filter((item): item is Extract<ImportItem, { ok: true }> => item.ok) ?? [];
  const existingCount = existingIds.length;
  /** Imported commands are appended after the existing steps, in order. */
  const numberOf = (stepId: string) => {
    const match = /^import:(\d+)$/.exec(stepId);
    if (!match) return existingIds.indexOf(stepId) + 1;
    return existingCount + valid.findIndex((item) => item.index === Number(match[1])) + 1;
  };

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<Preview>(`/scenarios/${scenarioId}/import-curl/preview`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setPreview(result);
      setAccepted(new Set(result.dependencies.filter((item) => item.confidence !== "LOW").map((item) => item.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ imported: number }>(`/scenarios/${scenarioId}/import-curl`, {
        method: "POST",
        body: JSON.stringify({ text, accept: [...accepted], skipInvalid: true }),
      });
      await onImported({ imported: result.imported, firstStepIndex: existingCount });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("builder.import.title")}
      description={t("builder.import.hint")}
      closeLabel={t("builder.panel.close")}
      onClose={onClose}
      className="max-w-3xl"
      footer={
        preview ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
              <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
              {t("builder.import.back")}
            </Button>
            <Button disabled={busy || valid.length === 0} onClick={() => void submit()}>
              {t("builder.import.import", { count: n(valid.length) })}
            </Button>
          </>
        ) : (
          <Button disabled={busy || !text.trim()} onClick={() => void review()}>
            {t("builder.import.review")}
          </Button>
        )
      }
    >
      {error ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {err(error)}
        </p>
      ) : null}
      {!preview ? (
        <textarea
          data-autofocus
          aria-label={t("builder.import.title")}
          className="min-h-72 w-full rounded-md border border-border bg-background p-3 font-mono text-xs"
          dir="ltr"
          spellCheck={false}
          value={text}
          placeholder={t("builder.import.placeholder")}
          onChange={(event) => setText(event.target.value)}
        />
      ) : (
        <div className="space-y-4">
          <ol className="space-y-1.5">
            {preview.items.map((item) =>
              item.ok ? (
                <li key={item.index} className="rounded-md border border-border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-5 shrink-0 font-mono text-[11px] text-muted-foreground">{n(numberOf(`import:${item.index}`))}</span>
                    <span className="shrink-0 font-mono text-[10px] font-semibold text-primary">{item.method}</span>
                    <span className="min-w-0 truncate font-mono text-xs dir-ltr" dir="ltr" title={item.url}>
                      {item.url}
                    </span>
                  </div>
                  <p className="ps-7 text-[11px] text-muted-foreground">
                    {t("builder.import.headersCount", { count: n(Object.keys(item.headers).length) })}
                    {" · "}
                    {t(`builder.import.body.${item.body}`)}
                    {item.query.length ? ` · ?${item.query.join("&")}` : ""}
                  </p>
                  {item.warnings.map((warning) => (
                    <p key={`${warning.code}:${warning.detail}`} className="flex items-start gap-1 ps-7 text-[11px] text-warning">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="break-all">{t(`builder.import.warnings.${warning.code}`, { detail: warning.detail })}</span>
                    </p>
                  ))}
                </li>
              ) : (
                <li key={item.index} className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
                  <p className="flex items-start gap-1 text-xs text-destructive">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("builder.import.invalid", { reason: t(`scenarios.curlErrors.${item.code}`) })}
                  </p>
                  <p className="truncate ps-5 font-mono text-[10px] text-muted-foreground dir-ltr" dir="ltr">
                    {item.preview}
                  </p>
                </li>
              ),
            )}
          </ol>

          <section className="space-y-2" aria-labelledby="import-connections">
            <div>
              <h3 id="import-connections" className="text-xs font-medium">
                {t("builder.import.connections")}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {preview.dependencies.length ? t("builder.import.connectionsHint") : t("builder.import.noConnections")}
              </p>
            </div>
            <ul className="space-y-1">
              {preview.dependencies.map((suggestion) => {
                const checked = accepted.has(suggestion.id);
                return (
                  <li key={suggestion.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs",
                        checked ? "border-primary/50 bg-primary/5" : "border-border",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        onChange={(event) =>
                          setAccepted((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(suggestion.id);
                            else next.delete(suggestion.id);
                            return next;
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="block">
                          <span className="text-muted-foreground">{t("builder.flow.step", { n: n(numberOf(suggestion.consumerStepId)) })} · </span>
                          <span className="font-medium">
                            {t(`builder.picker.locations.${suggestion.target.location}`)} · {suggestion.target.key}
                          </span>
                          <span className="text-muted-foreground"> ← </span>
                          {source(suggestion, numberOf(suggestion.producerStepId))}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {t(`builder.detected.confidence.${suggestion.confidence}`)} · {t(`builder.detected.reasons.${suggestion.reason}`)} ·{" "}
                          {suggestion.evidence === "response" ? t("builder.detected.verified") : t("builder.detected.inferred")}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </Dialog>
  );
}
