"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

type Settings = {
  provider: "ollama" | "openai";
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  hasApiKey: boolean;
  external: boolean;
  allowExternal: boolean;
  deepAnalysis: boolean;
  analysisReady: boolean;
  blockedReason: "disabled" | "external_not_allowed" | "missing_api_key" | null;
  connection: string;
  latencyMs: number | null;
  structuredOutput: string | null;
  lastError: string | null;
};

/** Free or local services that work out of the box; model names are suggestions — "Load models" lists the real ones. */
const PRESETS = [
  { id: "ollama", provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen2.5:14b" },
  { id: "groq", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "openrouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free" },
  { id: "gemini", provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  { id: "lmstudio", provider: "openai", baseUrl: "http://localhost:1234/v1", model: "" },
] as const;

const input = "h-8 w-full rounded-md border border-border bg-background px-2 text-sm";

export function AiSettings() {
  const { t, err } = useI18n();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState({ provider: "ollama", baseUrl: "", model: "", temperature: "0.2", timeoutMs: "120000", deepAnalysis: true, allowExternal: false });
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (settings: Settings) => {
    setSaved(settings);
    setForm({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: String(settings.temperature),
      timeoutMs: String(settings.timeoutMs),
      deepAnalysis: settings.deepAnalysis,
      allowExternal: settings.allowExternal,
    });
  };

  useEffect(() => {
    api<Settings>("/ai/settings").then(apply).catch(() => undefined);
  }, []);

  const preset = PRESETS.find((item) => item.baseUrl === form.baseUrl)?.id ?? "custom";
  const external = (() => {
    try {
      const host = new URL(form.baseUrl).hostname;
      return !(host === "localhost" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local"));
    } catch {
      return true;
    }
  })();

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? err(error.message) : t("settings.lastError"));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const next = await api<Settings>("/ai/settings", {
        method: "PUT",
        body: JSON.stringify({
          provider: form.provider,
          baseUrl: form.baseUrl,
          model: form.model,
          temperature: Number(form.temperature),
          timeoutMs: Number(form.timeoutMs),
          deepAnalysis: form.deepAnalysis,
          allowExternal: external ? form.allowExternal : false,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      apply(next);
      setApiKey("");
      setMessage(t("settings.saved"));
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.aiTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("aiSettings.hint")}</p>

        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("aiSettings.service")}</span>
          <select
            className={input}
            value={preset}
            onChange={(event) => {
              const chosen = PRESETS.find((item) => item.id === event.target.value);
              if (chosen) {
                setForm((current) => ({ ...current, provider: chosen.provider, baseUrl: chosen.baseUrl, model: chosen.model, allowExternal: false }));
              } else {
                setForm((current) => ({ ...current, provider: "openai" }));
              }
              setModels([]);
            }}
          >
            {PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {t(`aiSettings.presets.${item.id}`)}
              </option>
            ))}
            <option value="custom">{t("aiSettings.presets.custom")}</option>
          </select>
          <span className="block text-[11px] text-muted-foreground">{t(`aiSettings.presetHints.${preset}`)}</span>
        </label>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("aiSettings.protocol")}</span>
            <select className={input} value={form.provider} onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value }))}>
              <option value="ollama">Ollama API</option>
              <option value="openai">OpenAI-compatible API</option>
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("settings.baseUrl")}</span>
            <input className={`${input} font-mono`} dir="ltr" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("settings.model")}</span>
            {models.length > 0 ? (
              <select className={`${input} font-mono`} dir="ltr" value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}>
                {[...new Set([form.model, ...models])].filter(Boolean).map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            ) : (
              <input className={`${input} font-mono`} dir="ltr" value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} />
            )}
          </label>
          {form.provider === "openai" ? (
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("aiSettings.apiKey")}</span>
              <input
                className={`${input} font-mono`}
                dir="ltr"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={saved?.hasApiKey ? t("aiSettings.apiKeyKept") : t("aiSettings.apiKeyPlaceholder")}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          ) : null}
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("settings.temperature")}</span>
            <input className={`${input} font-mono`} dir="ltr" value={form.temperature} onChange={(event) => setForm((current) => ({ ...current, temperature: event.target.value }))} />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("settings.timeout")}</span>
            <input className={`${input} font-mono`} dir="ltr" value={form.timeoutMs} onChange={(event) => setForm((current) => ({ ...current, timeoutMs: event.target.value }))} />
          </label>
        </div>

        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={form.deepAnalysis} onChange={(event) => setForm((current) => ({ ...current, deepAnalysis: event.target.checked }))} />
          <span>
            {t("aiSettings.deepAnalysis")}
            <span className="block text-[11px] text-muted-foreground">{t("aiSettings.deepAnalysisHint")}</span>
          </span>
        </label>

        {external ? (
          <div className="space-y-1 rounded-md border border-warning/50 bg-warning/5 p-2">
            <p className="flex items-start gap-1.5 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("aiSettings.externalWarning")}
            </p>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.allowExternal}
                onChange={(event) => setForm((current) => ({ ...current, allowExternal: event.target.checked }))}
              />
              {t("aiSettings.allowExternal")}
            </label>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run(async () => apply(await api<Settings>("/ai/settings/test", { method: "POST" })))}
          >
            {t("settings.testConnection")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<{ models: string[]; error: string | null }>("/ai/settings/models");
                setModels(result.models);
                if (result.error) setMessage(err(result.error));
                else if (!result.models.length) setMessage(t("settings.noModels"));
              })
            }
          >
            {t("settings.refreshModels")}
          </Button>
          {saved?.hasApiKey && form.provider === "openai" ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => apply(await api<Settings>("/ai/settings", { method: "PUT", body: JSON.stringify({ clearApiKey: true }) })))
              }
            >
              {t("aiSettings.removeKey")}
            </Button>
          ) : null}
        </div>

        {saved ? (
          <p className={saved.analysisReady ? "flex items-center gap-1.5 text-xs text-success" : "flex items-center gap-1.5 text-xs text-warning"}>
            {saved.analysisReady ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {saved.analysisReady ? t("aiSettings.ready") : t(`aiSettings.blocked.${saved.blockedReason}`)}
          </p>
        ) : null}
        {saved ? (
          <p className="font-mono text-[10px] text-muted-foreground">
            {t("settings.connection")}: {saved.connection}
            {saved.latencyMs !== null ? ` · ${t("settings.latency")}: ${saved.latencyMs}ms` : ""}
            {saved.structuredOutput ? ` · ${t("settings.structuredOutput")}: ${saved.structuredOutput}` : ""}
          </p>
        ) : null}
        {saved?.lastError ? <p className="break-all text-xs text-destructive">{err(saved.lastError)}</p> : null}
        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
