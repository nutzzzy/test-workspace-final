"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, Download, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { copyText, downloadText } from "@/lib/download";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  canGenerate,
  defaultProvider,
  filenameOf,
  initialSelection,
  languagesOf,
  resultMatches,
  withFramework,
  type ExportOptions,
  type ExportResult,
  type ExportSelection,
} from "./export-selection";

const SELECT = "h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-60";

/**
 * Export a precondition — all its steps, or one `step` on its own — as
 * automation code: choose framework, language and one of the workspace's AI
 * connections, generate, then copy or download. The precondition itself is
 * only read. Frameworks that cannot drive the steps (a browser framework for
 * a mobile step, or the reverse) are listed but cannot be chosen.
 */
export function ExportDialog({ scenarioId, step = null, onClose }: { scenarioId: string; step?: { id: string; name: string } | null; onClose: () => void }) {
  const { t, err } = useI18n();
  const toast = useToast();
  const [options, setOptions] = useState<ExportOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ExportSelection | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [generatedWith, setGeneratedWith] = useState<ExportSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Only the latest request may update the dialog (a regenerate or a closed dialog makes older ones stale). */
  const requestRef = useRef(0);

  const query = step ? `?stepId=${encodeURIComponent(step.id)}` : "";

  useEffect(() => {
    let alive = true;
    api<ExportOptions>(`/scenarios/${scenarioId}/export${query}`)
      .then((loaded) => {
        if (!alive) return;
        setOptions(loaded);
        setSelection(initialSelection(loaded));
      })
      .catch((failure: unknown) => {
        if (alive) setLoadError(failure instanceof Error ? failure.message : "Load failed");
      });
    return () => {
      alive = false;
      requestRef.current += 1;
    };
  }, [scenarioId, query]);

  const generate = async () => {
    if (!options || !selection) return;
    const id = ++requestRef.current;
    const wanted = selection;
    setGenerating(true);
    setError(null);
    try {
      const generated = await api<ExportResult>(`/scenarios/${scenarioId}/export`, {
        method: "POST",
        body: JSON.stringify({
          framework: wanted.framework,
          language: wanted.language,
          ...(wanted.providerId ? { providerId: wanted.providerId } : {}),
          ...(step ? { stepId: step.id } : {}),
        }),
      });
      if (id !== requestRef.current) return;
      setResult(generated);
      setGeneratedWith(wanted);
    } catch (failure) {
      if (id !== requestRef.current) return;
      setResult(null);
      setGeneratedWith(null);
      setError(failure instanceof Error ? failure.message : "Request failed");
    } finally {
      if (id === requestRef.current) setGenerating(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    const ok = await copyText(result.code);
    toast.notify(ok ? "success" : "error", ok ? t("builder.export.copied") : t("builder.export.copyFailed"));
  };

  const fallback = options ? defaultProvider(options) : null;
  const current = Boolean(result && selection && resultMatches(result, selection, generatedWith));
  const usable = options?.providers.some((item) => item.usable) ?? false;

  return (
    <Dialog
      open
      title={step ? t("builder.export.titleStep", { name: step.name }) : t("builder.export.title")}
      description={step ? t("builder.export.descriptionStep") : t("builder.export.description")}
      closeLabel={t("common.cancel")}
      onClose={onClose}
      className="max-w-4xl"
      footer={
        <>
          {result && current ? (
            <>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                <Copy className="h-3.5 w-3.5" />
                {t("builder.export.copy")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadText(result.filename, result.code)}>
                <Download className="h-3.5 w-3.5" />
                {t("builder.export.download")}
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            data-autofocus
            disabled={!options || !selection || generating || !canGenerate(options, selection)}
            onClick={() => void generate()}
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : result && current ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {generating ? t("builder.export.generating") : result && current ? t("builder.export.regenerate") : t("builder.export.generate")}
          </Button>
        </>
      }
    >
      {loadError ? (
        <p role="alert" className="text-xs text-destructive">
          {err(loadError)}
        </p>
      ) : !options || !selection ? (
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("builder.export.framework")}</span>
              <select
                className={SELECT}
                value={selection.framework}
                disabled={generating}
                onChange={(event) => setSelection(withFramework(options, selection, event.target.value))}
              >
                {options.frameworks.map((framework) => (
                  <option key={framework.id} value={framework.id} disabled={framework.available === false}>
                    {framework.available === false
                      ? t("builder.export.unavailable", {
                          name: framework.label,
                          reason: t(`builder.export.unavailableReason.${framework.unavailableReason ?? "mobileOnly"}`),
                        })
                      : framework.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("builder.export.provider")}</span>
              <select
                className={SELECT}
                value={selection.providerId}
                disabled={generating || !usable}
                onChange={(event) => setSelection({ ...selection, providerId: event.target.value })}
              >
                <option value="">
                  {fallback ? t("builder.export.workspaceDefault", { name: `${fallback.name} · ${fallback.model}` }) : t("builder.export.workspaceDefaultNone")}
                </option>
                {options.providers.map((provider) => (
                  <option key={provider.id} value={provider.id} disabled={!provider.usable}>
                    {provider.usable
                      ? `${provider.name} · ${provider.model}`
                      : t("builder.export.providerBlocked", { name: provider.name, reason: t(`aiSettings.blocked.${provider.blockedReason ?? "disabled"}`) })}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("builder.export.language")}</span>
              <select
                className={SELECT}
                value={selection.language}
                disabled={generating}
                onChange={(event) => setSelection({ ...selection, language: event.target.value })}
              >
                {languagesOf(options, selection.framework).map((language) => (
                  <option key={language.id} value={language.id}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!usable ? <p className="text-xs text-warning">{t("builder.export.noProviders")}</p> : null}

          {error ? (
            <div role="alert" className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
              <p className="text-destructive">{err(error)}</p>
              <p className="text-muted-foreground">{t("builder.export.unchanged")}</p>
            </div>
          ) : null}

          {generating ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t("builder.export.generatingHint")}
            </p>
          ) : null}

          {result && current ? (
            <section className="space-y-2" aria-label={t("builder.export.code")}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-mono text-foreground" dir="ltr">
                  {result.filename}
                </span>
                <span className="text-muted-foreground">{t("builder.export.writtenBy", { name: result.provider.name, model: result.provider.model })}</span>
              </div>
              {result.warnings.length ? (
                <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                  <p className="flex items-center gap-1.5 font-medium text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {t("builder.export.warnings")}
                  </p>
                  <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground" dir="auto">
                    {result.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <pre
                dir="ltr"
                tabIndex={0}
                aria-label={t("builder.export.code")}
                className="max-h-[50dvh] overflow-auto rounded-md border border-border bg-muted/30 p-3 text-start font-mono text-[11px] leading-relaxed text-foreground"
              >
                <code>{result.code}</code>
              </pre>
            </section>
          ) : !generating ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {result ? t("builder.export.changed") : t("builder.export.empty", { filename: filenameOf(options, selection) })}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
