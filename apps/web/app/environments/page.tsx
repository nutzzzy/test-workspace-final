"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";

type Env = {
  id: string;
  name: string;
  description?: string;
  variables: Array<{
    id: string;
    key: string;
    value: string;
    type: string;
    hasValue: boolean;
  }>;
};

export default function EnvironmentsPage() {
  const { t, err } = useI18n();
  const [envs, setEnvs] = useState<Env[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [envId, setEnvId] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [type, setType] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const reload = async () => {
    const list = await api<Env[]>("/environments");
    setEnvs(list);
    if (!envId && list[0]) setEnvId(list[0].id);
  };

  useEffect(() => {
    void reload().catch((e: Error) => setMessage(e.message));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{t("environments.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("environments.subtitle")}
        </p>
      </div>

      {message ? <p className="text-xs text-destructive">{err(message)}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("environments.createEnv")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("common.name")}
            />
            <Button
              disabled={!name.trim()}
              onClick={async () => {
                const created = await api<Env>("/environments", {
                  method: "POST",
                  body: JSON.stringify({ name, description }),
                });
                setEnvId(created.id);
                setName("");
                setDescription("");
                await reload();
              }}
            >
              {t("common.create")}
            </Button>
          </div>
          <input
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("common.description")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("environments.addVariable")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={envId}
            onChange={(e) => setEnvId(e.target.value)}
          >
            <option value="">{t("common.select")}</option>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">{t("common.select")}</option>
            <option value="NORMAL">{t("environments.normal")}</option>
            <option value="SECRET">{t("environments.secret")}</option>
          </select>
          <input
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm"
            dir="ltr"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="base_url"
          />
          <input
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm"
            dir="ltr"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://api.example.com"
            type={type === "SECRET" ? "password" : "text"}
          />
          <Button
            className="md:col-span-2"
            disabled={!envId || !key.trim() || !type}
            onClick={async () => {
              await api("/environments/variables", {
                method: "POST",
                body: JSON.stringify({
                  environmentId: envId,
                  key,
                  value,
                  type,
                }),
              });
              await reload();
              setMessage(t("environments.savedVar", { key }));
              setKey("");
              setValue("");
              setType("");
            }}
          >
            {t("common.save")}
          </Button>
        </CardContent>
      </Card>

      {envs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
      ) : null}
      {envs.map((env) => (
        <Card key={env.id}>
          <CardHeader>
            <div className="flex w-full items-center justify-between gap-2">
              <CardTitle>{env.name}</CardTitle>
              <Button
                size="sm"
                variant="destructive"
                onClick={async () => {
                  if (!window.confirm(t("common.confirmDelete", { name: env.name }))) return;
                  await api(`/environments/${env.id}`, { method: "DELETE" });
                  if (envId === env.id) setEnvId("");
                  await reload();
                }}
              >
                {t("common.delete")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {env.description ? (
              <p className="mb-2 text-xs text-muted-foreground">{env.description}</p>
            ) : null}
            {env.variables.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("common.empty")}</p>
            ) : (
              env.variables.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5 font-mono text-xs"
                >
                  <span className="min-w-0 truncate dir-ltr text-start">
                    <span className="text-primary">{`{{${v.key}}}`}</span>
                    {" = "}
                    {v.value}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge>
                      {v.type === "SECRET"
                        ? t("environments.secret")
                        : t("environments.normal")}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (!window.confirm(t("common.confirmDelete", { name: v.key }))) return;
                        await api(`/environments/${env.id}/variables/${v.key}`, {
                          method: "DELETE",
                        });
                        await reload();
                      }}
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
