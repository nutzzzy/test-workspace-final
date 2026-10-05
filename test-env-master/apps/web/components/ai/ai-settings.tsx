"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Connection = {
  id: string;
  name: string;
  kind: "ollama" | "openai";
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  external: boolean;
  allowExternal: boolean;
  enabled: boolean;
  temperature: number;
  timeoutMs: number;
  contextTokens: number;
  reasoning: boolean;
  priority: number;
  usable: boolean;
  blockedReason: "disabled" | "external_not_allowed" | "missing_api_key" | null;
  lastStatus: string | null;
  lastError: string | null;
};

type Routing = Record<string, string[]>;
const GROUPS = ["analysis", "testCases", "edgeCases", "review", "automation", "translate", "learning"] as const;

/** Free (or local) services. `vpn`: blocked from some regions. Model names are suggestions — "Load models" lists the real ones. */
const PRESETS = [
  { id: "ollama", name: "Local Ollama", kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b", contextTokens: 24576 },
  { id: "lmstudio", name: "LM Studio", kind: "openai", baseUrl: "http://localhost:1234/v1", model: "", contextTokens: 16384 },
  { id: "huggingface", name: "Hugging Face", kind: "openai", baseUrl: "https://router.huggingface.co/v1", model: "Qwen/Qwen2.5-72B-Instruct", contextTokens: 32768 },
  { id: "github", name: "GitHub Models", kind: "openai", baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4.1-mini", contextTokens: 32768 },
  { id: "sambanova", name: "SambaNova", kind: "openai", baseUrl: "https://api.sambanova.ai/v1", model: "DeepSeek-V3.1", contextTokens: 65536 },
  { id: "cerebras", name: "Cerebras", kind: "openai", baseUrl: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", contextTokens: 32768 },
  { id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", contextTokens: 32768 },
  { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", contextTokens: 32768, vpn: true },
  { id: "gemini", name: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", contextTokens: 131072, vpn: true },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", contextTokens: 32768, vpn: true },
] as const;

const input = "h-8 w-full rounded-md border border-border bg-background px-2 text-sm";

type Form = {
  id?: string;
  preset: string;
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  allowExternal: boolean;
  enabled: boolean;
  contextTokens: string;
  timeoutMs: string;
  temperature: string;
  reasoning: boolean;
  hasApiKey?: boolean;
};

const blankForm = (preset: (typeof PRESETS)[number] = PRESETS[0]): Form => ({
  preset: preset.id,
  name: preset.name,
  kind: preset.kind,
  baseUrl: preset.baseUrl,
  model: preset.model,
  apiKey: "",
  allowExternal: false,
  enabled: true,
  contextTokens: String(preset.contextTokens),
  timeoutMs: "600000",
  temperature: "0.2",
  reasoning: false,
});

const isExternalUrl = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return !(host === "localhost" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local"));
  } catch {
    return true;
  }
};

export function AiSettings() {
  const { t, n, err } = useI18n();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [routing, setRouting] = useState<Routing>({});
  const [form, setForm] = useState<Form | null>(null);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [pull, setPull] = useState<{ id: string; model: string; status: string; completed: number; total: number; state: string; error?: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, route] = await Promise.all([api<Connection[]>("/ai/connections"), api<Routing>("/ai/routing")]);
    setConnections(list);
    setRouting(route);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!pull || pull.state !== "running") return;
    const id = setInterval(() => {
      void api<typeof pull>(`/ai/connections/${pull.id}/pull`).then((next) => next && setPull({ ...next!, id: pull.id }));
    }, 1500);
    return () => clearInterval(id);
  }, [pull]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? err(e.message) : t("settings.lastError"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!form) return;
      const body = {
        name: form.name,
        kind: form.kind,
        baseUrl: form.baseUrl,
        model: form.model,
        enabled: form.enabled,
        allowExternal: isExternalUrl(form.baseUrl) ? form.allowExternal : false,
        contextTokens: Number(form.contextTokens),
        timeoutMs: Number(form.timeoutMs),
        temperature: Number(form.temperature),
        reasoning: form.reasoning,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };
      await api(form.id ? `/ai/connections/${form.id}` : "/ai/connections", { method: form.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      setForm(null);
    });

  const external = form ? isExternalUrl(form.baseUrl) : false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.aiTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("aiSettings.hint")}</p>

        <ul className="space-y-2">
          {connections.map((item) => (
            <li key={item.id} className={cn("space-y-1.5 rounded-md border px-3 py-2", item.usable ? "border-border" : "border-warning/50")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{item.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                  {item.model}
                </span>
                {item.usable ? (
                  <span className="flex items-center gap-1 text-[11px] text-success">
                    <CheckCircle2 className="h-3 w-3" />
                    {t("aiSettings.usable")}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[11px] text-warning">
                    <AlertTriangle className="h-3 w-3" />
                    {t(`aiSettings.blocked.${item.blockedReason}`)}
                  </span>
                )}
                <span className="ms-auto flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api(`/ai/connections/${item.id}/test`, { method: "POST", body: "{}" }))}>
                    {t("settings.testConnection")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ models: string[]; error: string | null }>(`/ai/connections/${item.id}/models`);
                        if (result.error) throw new Error(result.error);
                        setModels((current) => ({ ...current, [item.id]: result.models }));
                      })
                    }
                  >
                    {t("settings.refreshModels")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("studio.edit")}
                    onClick={() =>
                      setForm({
                        id: item.id,
                        preset: PRESETS.find((preset) => preset.baseUrl === item.baseUrl)?.id ?? "custom",
                        name: item.name,
                        kind: item.kind,
                        baseUrl: item.baseUrl,
                        model: item.model,
                        apiKey: "",
                        allowExternal: item.allowExternal,
                        enabled: item.enabled,
                        contextTokens: String(item.contextTokens),
                        timeoutMs: String(item.timeoutMs),
                        temperature: String(item.temperature),
                        reasoning: item.reasoning,
                        hasApiKey: item.hasApiKey,
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("studio.delete")}
                    onClick={() => {
                      if (window.confirm(t("common.confirmDelete", { name: item.name }))) void run(() => api(`/ai/connections/${item.id}`, { method: "DELETE" }));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>
              <div className="font-mono text-[10px] text-muted-foreground" dir="ltr">
                {item.baseUrl} · ctx {item.contextTokens}
                {item.lastStatus ? ` · ${item.lastStatus}` : ""}
              </div>
              {item.lastError ? <p className="break-all text-[11px] text-destructive">{err(item.lastError)}</p> : null}
              {models[item.id]?.length ? (
                <label className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t("settings.model")}</span>
                  <select
                    className={cn(input, "h-7 w-auto font-mono text-xs")}
                    dir="ltr"
                    value={item.model}
                    onChange={(event) => void run(() => api(`/ai/connections/${item.id}`, { method: "PATCH", body: JSON.stringify({ model: event.target.value }) }))}
                  >
                    {[...new Set([item.model, ...models[item.id]!])].map((model) => (
                      <option key={model}>{model}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {item.kind === "ollama" ? (
                <form
                  className="flex flex-wrap items-center gap-2 text-xs"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const model = String(new FormData(event.currentTarget).get("model") ?? "").trim();
                    if (model) void api<typeof pull>(`/ai/connections/${item.id}/pull`, { method: "POST", body: JSON.stringify({ model }) }).then((next) => next && setPull({ ...next!, id: item.id }));
                  }}
                >
                  <input name="model" className={cn(input, "h-7 w-44 font-mono text-xs")} dir="ltr" placeholder="qwen3:14b" />
                  <Button size="sm" variant="ghost" type="submit">
                    <Download className="h-3.5 w-3.5" />
                    {t("aiSettings.pull")}
                  </Button>
                  {pull?.id === item.id ? (
                    <span className={cn("text-[11px]", pull.state === "failed" ? "text-destructive" : "text-muted-foreground")} dir="ltr">
                      {pull.model}: {pull.state === "failed" ? pull.error : pull.total ? `${Math.round((pull.completed / pull.total) * 100)}%` : pull.status}
                    </span>
                  ) : null}
                </form>
              ) : null}
            </li>
          ))}
        </ul>

        <Button variant="outline" onClick={() => setForm(blankForm())}>
          <Plus className="h-3.5 w-3.5" />
          {t("aiSettings.add")}
        </Button>

        {connections.length > 1 ? (
          <section className="space-y-2 rounded-md border border-border p-3" aria-labelledby="routing-title">
            <h3 id="routing-title" className="text-xs font-medium">
              {t("aiSettings.routing")}
            </h3>
            <p className="text-[11px] text-muted-foreground">{t("aiSettings.routingHint")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {GROUPS.map((group) => (
                <label key={group} className="flex items-center justify-between gap-2 text-xs">
                  <span>{t(`aiSettings.groups.${group}`)}</span>
                  <select
                    className={cn(input, "h-7 w-48 text-xs")}
                    value={routing[group]?.[0] ?? ""}
                    onChange={(event) =>
                      void run(() => api("/ai/routing", { method: "PUT", body: JSON.stringify({ ...routing, [group]: event.target.value ? [event.target.value] : [] }) }))
                    }
                  >
                    <option value="">{t("aiSettings.automatic")}</option>
                    {connections.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.model}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </section>
        ) : null}
        {message ? <p className="text-xs text-destructive">{message}</p> : null}

        <Dialog
          open={Boolean(form)}
          title={form?.id ? t("aiSettings.edit") : t("aiSettings.add")}
          closeLabel={t("studio.cancel")}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="outline" onClick={() => setForm(null)}>
                {t("studio.cancel")}
              </Button>
              <Button disabled={busy || !form?.baseUrl || !form?.model} onClick={() => void save()}>
                {t("studio.save")}
              </Button>
            </>
          }
        >
          {form ? (
            <div className="space-y-3">
              {!form.id ? (
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("aiSettings.service")}</span>
                  <select
                    className={input}
                    value={form.preset}
                    onChange={(event) => {
                      const preset = PRESETS.find((item) => item.id === event.target.value);
                      setForm(preset ? blankForm(preset) : { ...form, preset: "custom", kind: "openai" });
                    }}
                  >
                    {PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {t(`aiSettings.presets.${preset.id}`)}
                      </option>
                    ))}
                    <option value="custom">{t("aiSettings.presets.custom")}</option>
                  </select>
                  <span className="block text-[11px] text-muted-foreground">{t(`aiSettings.presetHints.${form.preset}`)}</span>
                </label>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("common.name")}</span>
                  <input className={input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </label>
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("aiSettings.protocol")}</span>
                  <select className={input} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
                    <option value="ollama">Ollama API</option>
                    <option value="openai">OpenAI-compatible API</option>
                  </select>
                </label>
                <label className="block space-y-1 text-xs sm:col-span-2">
                  <span className="text-muted-foreground">{t("settings.baseUrl")}</span>
                  <input className={cn(input, "font-mono")} dir="ltr" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
                </label>
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("settings.model")}</span>
                  <input className={cn(input, "font-mono")} dir="ltr" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
                </label>
                {form.kind === "openai" ? (
                  <label className="block space-y-1 text-xs">
                    <span className="text-muted-foreground">{t("aiSettings.apiKey")}</span>
                    <input
                      className={cn(input, "font-mono")}
                      dir="ltr"
                      type="password"
                      autoComplete="off"
                      value={form.apiKey}
                      placeholder={form.hasApiKey ? t("aiSettings.apiKeyKept") : t("aiSettings.apiKeyPlaceholder")}
                      onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                    />
                  </label>
                ) : null}
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("aiSettings.context")}</span>
                  <input className={cn(input, "font-mono")} dir="ltr" inputMode="numeric" value={form.contextTokens} onChange={(event) => setForm({ ...form, contextTokens: event.target.value })} />
                </label>
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("settings.timeout")}</span>
                  <input className={cn(input, "font-mono")} dir="ltr" inputMode="numeric" value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
                {t("aiSettings.enabled")}
              </label>
              {form.kind === "ollama" ? (
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={form.reasoning} onChange={(event) => setForm({ ...form, reasoning: event.target.checked })} />
                  <span>
                    {t("aiSettings.reasoning")}
                    <span className="block text-[11px] text-muted-foreground">{t("aiSettings.reasoningHint")}</span>
                  </span>
                </label>
              ) : null}
              {external ? (
                <div className="space-y-1 rounded-md border border-warning/50 bg-warning/5 p-2">
                  <p className="flex items-start gap-1.5 text-[11px] text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("aiSettings.externalWarning")}
                  </p>
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={form.allowExternal} onChange={(event) => setForm({ ...form, allowExternal: event.target.checked })} />
                    {t("aiSettings.allowExternal")}
                  </label>
                </div>
              ) : null}
              <p className="text-[11px] text-muted-foreground">{t("aiSettings.contextHint", { chars: n(Math.round(Number(form.contextTokens || 0) * 1.2)) })}</p>
            </div>
          ) : null}
        </Dialog>
      </CardContent>
    </Card>
  );
}
