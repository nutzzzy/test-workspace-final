"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectorSettings } from "@/components/connectors/connector-settings";
import { useI18n, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Config = {
  baseUrl: string;
  email: string;
  projectKey?: string | null;
  hasToken: boolean;
} | null;

export default function SettingsPage() {
  const { t, err, locale, setLocale } = useI18n();
  const [savingJira, setSavingJira] = useState(false);
  const [config, setConfig] = useState<Config>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [ai, setAi] = useState({
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "",
    temperature: "0.2",
    timeoutMs: "60000",
    connection: "unknown",
    latencyMs: null as number | null,
    structuredOutput: null as string | null,
    lastError: null as string | null,
  });
  const [models, setModels] = useState<string[]>([]);
  const [aiMessage, setAiMessage] = useState<string | null>(null);

  useEffect(() => {
    api<Config>("/jira/config")
      .then((c) => {
        setConfig(c);
        if (c) {
          setBaseUrl(c.baseUrl);
          setEmail(c.email);
          setProjectKey(c.projectKey ?? "");
        }
      })
      .catch(() => setConfig(null));
    api<typeof ai>("/ai/settings")
      .then((settings) => {
        setAi({
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          temperature: String(settings.temperature),
          timeoutMs: String(settings.timeoutMs),
          connection: settings.connection,
          latencyMs: settings.latencyMs,
          structuredOutput: settings.structuredOutput,
          lastError: settings.lastError,
        });
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.subtitle")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.languageTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("settings.languageHint")}
          </p>
          <div className="text-xs text-muted-foreground">
            {t("settings.language")}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: "fa" as Locale, label: t("settings.persian") },
                { id: "en" as Locale, label: t("settings.english") },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setLocale(opt.id)}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm transition-colors",
                  locale === opt.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <div className="font-medium">{opt.label}</div>
                <div className="mt-0.5 font-mono text-[10px] opacity-70">
                  {opt.id === "fa" ? "RTL" : "LTR"}
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.jiraTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("settings.jiraHint")}</p>
          <Field
            label={t("settings.baseUrl")}
            value={baseUrl}
            onChange={setBaseUrl}
            dir="ltr"
          />
          <Field
            label={t("settings.email")}
            value={email}
            onChange={setEmail}
            dir="ltr"
          />
          <Field
            label={t("settings.apiToken")}
            value={apiToken}
            onChange={setApiToken}
            placeholder={
              config?.hasToken ? t("settings.apiTokenPlaceholder") : ""
            }
            dir="ltr"
            type="password"
          />
          <Field
            label={t("settings.projectKey")}
            value={projectKey}
            onChange={setProjectKey}
            dir="ltr"
          />
          <Button
            disabled={savingJira}
            onClick={async () => {
              // An empty token keeps the saved one; only a first setup needs it.
              if (!apiToken && !config?.hasToken) {
                setMessage(t("settings.provideToken"));
                return;
              }
              setSavingJira(true);
              setMessage(null);
              try {
                await api("/jira/config", {
                  method: "PUT",
                  body: JSON.stringify({
                    baseUrl,
                    email,
                    ...(apiToken ? { apiToken } : {}),
                    projectKey: projectKey || undefined,
                  }),
                });
                setApiToken("");
                setMessage(t("settings.saved"));
                const c = await api<Config>("/jira/config");
                setConfig(c);
              } catch (error) {
                setMessage(error instanceof Error ? err(error.message) : t("errors.failed"));
              } finally {
                setSavingJira(false);
              }
            }}
          >
            {savingJira ? t("common.processing") : t("common.save")}
          </Button>
          {message ? (
            <p className="text-xs text-muted-foreground">{message}</p>
          ) : null}
        </CardContent>
      </Card>

      <ConnectorSettings />

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.aiTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("settings.aiHint")}</p>
          <Field
            label={t("settings.provider")}
            value={ai.provider}
            onChange={(provider) => setAi((current) => ({ ...current, provider }))}
            dir="ltr"
          />
          <Field
            label={t("settings.baseUrl")}
            value={ai.baseUrl}
            onChange={(baseUrl) => setAi((current) => ({ ...current, baseUrl }))}
            dir="ltr"
          />
          <Field
            label={t("settings.model")}
            value={ai.model}
            onChange={(model) => setAi((current) => ({ ...current, model }))}
            dir="ltr"
          />
          {models.length > 0 ? (
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("settings.refreshModels")}</span>
              <select
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={ai.model}
                onChange={(event) =>
                  setAi((current) => ({ ...current, model: event.target.value }))
                }
              >
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Field
              label={t("settings.temperature")}
              value={ai.temperature}
              onChange={(temperature) => setAi((current) => ({ ...current, temperature }))}
              dir="ltr"
            />
            <Field
              label={t("settings.timeout")}
              value={ai.timeoutMs}
              onChange={(timeoutMs) => setAi((current) => ({ ...current, timeoutMs }))}
              dir="ltr"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                void api("/ai/settings", {
                  method: "PUT",
                  body: JSON.stringify({
                    provider: ai.provider,
                    baseUrl: ai.baseUrl,
                    model: ai.model,
                    temperature: Number(ai.temperature),
                    timeoutMs: Number(ai.timeoutMs),
                  }),
                })
                  .then(() => setAiMessage(t("settings.saved")))
                  .catch((error: unknown) =>
                    setAiMessage(error instanceof Error ? err(error.message) : t("settings.lastError")),
                  );
              }}
            >
              {t("common.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void api<typeof ai>("/ai/settings/test", { method: "POST" })
                  .then((settings) => {
                    setAi((current) => ({
                      ...current,
                      connection: settings.connection,
                      latencyMs: settings.latencyMs,
                      structuredOutput: settings.structuredOutput,
                      lastError: settings.lastError,
                    }));
                  })
                  .catch((error: unknown) =>
                    setAiMessage(error instanceof Error ? err(error.message) : t("settings.lastError")),
                  );
              }}
            >
              {t("settings.testConnection")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void api<{ models: string[]; error: string | null }>("/ai/settings/models")
                  .then((result) => {
                    setModels(result.models);
                    setAiMessage(result.error ?? (result.models.length ? null : t("settings.noModels")));
                  })
                  .catch((error: unknown) =>
                    setAiMessage(error instanceof Error ? err(error.message) : t("settings.lastError")),
                  );
              }}
            >
              {t("settings.refreshModels")}
            </Button>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            {t("settings.connection")}: {ai.connection}
            {ai.latencyMs !== null ? ` · ${t("settings.latency")}: ${ai.latencyMs}ms` : ""}
            {ai.structuredOutput ? ` · ${t("settings.structuredOutput")}: ${ai.structuredOutput}` : ""}
          </p>
          {ai.lastError ? (
            <p className="text-xs text-destructive">{err(ai.lastError)}</p>
          ) : null}
          {aiMessage ? <p className="text-xs text-muted-foreground">{aiMessage}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  dir,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  dir?: "ltr" | "rtl";
  type?: "text" | "password";
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
        value={value}
        type={type}
        autoComplete={type === "password" ? "new-password" : undefined}
        placeholder={placeholder}
        dir={dir}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
