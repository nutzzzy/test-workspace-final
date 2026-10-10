"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

type Connector = {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  verifyCert: boolean;
  status: "ACTIVE" | "INACTIVE";
  hasPassword: boolean;
  options?: string;
  lastTestStatus?: "OK" | "FAILED" | null;
  lastTestedAt?: string | null;
  lastTestMessage?: string | null;
};

const TYPES = [
  "MYSQL",
  "POSTGRESQL",
  "ORACLE",
  "SQLSERVER",
  "MONGODB",
  "REDIS",
  "ELASTICSEARCH",
] as const;

const EMPTY = {
  name: "",
  type: "POSTGRESQL",
  host: "127.0.0.1",
  port: "5432",
  database: "",
  username: "",
  password: "",
  ssl: false,
  verifyCert: true,
  options: "",
  status: "ACTIVE" as "ACTIVE" | "INACTIVE",
};

export function ConnectorSettings() {
  const { t, err, d } = useI18n();
  const toast = useToast();
  const [rows, setRows] = useState<Connector[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Connector | null>(null);

  const load = async () => {
    setRows(await api<Connector[]>("/database-connectors"));
  };

  useEffect(() => {
    load().catch((error) =>
      setMessage(error instanceof Error ? err(error.message) : t("errors.loadFailed")),
    );
  }, [err, t]);

  const submit = async () => {
    const body = {
      ...form,
      port: Number(form.port),
    };
    setBusy("save");
    try {
      if (editing) {
        await api(`/database-connectors/${editing}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await api("/database-connectors", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      setForm(EMPTY);
      setEditing(null);
      setMessage(t("connectors.savedOk"));
      toast.notify("success", t("connectors.savedOk"));
      await load();
    } catch (error) {
      const text = error instanceof Error ? err(error.message) : t("errors.failed");
      setMessage(text);
      toast.notify("error", text);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setBusy(pendingDelete.id);
    try {
      await api(`/database-connectors/${pendingDelete.id}`, { method: "DELETE" });
      if (editing === pendingDelete.id) {
        setEditing(null);
        setForm(EMPTY);
      }
      setPendingDelete(null);
      toast.notify("success", t("connectors.deleted"));
      await load();
    } catch (error) {
      toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("connectors.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("connectors.hint")}</p>
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-3">
            <p className="text-sm text-muted-foreground">{t("connectors.empty")}</p>
            <Button
              className="mt-2"
              size="sm"
              type="button"
              onClick={() => document.getElementById("connector-name")?.focus()}
            >
              {t("connectors.create")}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-2 py-1 text-start font-medium">{t("connectors.name")}</th>
                  <th className="px-2 py-1 text-start font-medium">{t("connectors.type")}</th>
                  <th className="px-2 py-1 text-start font-medium">{t("connectors.host")}</th>
                  <th className="px-2 py-1 text-start font-medium">{t("connectors.status")}</th>
                  <th className="px-2 py-1 text-start font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border">
                    <td className="px-2 py-1">{row.name}</td>
                    <td className="px-2 py-1 font-mono">{row.type}</td>
                    <td className="px-2 py-1 font-mono dir-ltr">{row.host}:{row.port}</td>
                    <td className="px-2 py-1">
                      <div>{row.status === "ACTIVE" ? t("connectors.active") : t("connectors.inactive")}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {row.lastTestStatus === "OK"
                          ? t("connectors.testOk")
                          : row.lastTestStatus === "FAILED"
                            ? row.lastTestMessage || t("errors.unableToConnect")
                            : t("connectors.neverTested")}
                        {row.lastTestedAt ? ` · ${d(row.lastTestedAt)}` : ""}
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === row.id}
                          onClick={async () => {
                            setBusy(row.id);
                            try {
                              await api(`/database-connectors/${row.id}/test`, { method: "POST", body: "{}" });
                              setMessage(t("connectors.testOk"));
                              toast.notify("success", t("connectors.testOk"));
                              await load();
                            } catch (error) {
                              const text = error instanceof Error ? err(error.message) : t("errors.failed");
                              setMessage(text);
                              toast.notify("error", text);
                              await load().catch(() => undefined);
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          {t("connectors.test")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === row.id}
                          onClick={async () => {
                            setBusy(row.id);
                            try {
                              await api(`/database-connectors/${row.id}`, {
                                method: "PATCH",
                                body: JSON.stringify({
                                  status: row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                                }),
                              });
                              await load();
                            } catch (error) {
                              toast.notify(
                                "error",
                                error instanceof Error ? err(error.message) : t("errors.failed"),
                              );
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          {row.status === "ACTIVE" ? t("common.disable") : t("common.enable")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(row.id);
                            setForm({
                              name: row.name,
                              type: row.type,
                              host: row.host,
                              port: String(row.port),
                              database: row.database,
                              username: row.username,
                              password: "",
                              ssl: row.ssl,
                              verifyCert: row.verifyCert,
                              options: row.options ?? "",
                              status: row.status,
                            });
                          }}
                        >
                          {t("common.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy === row.id}
                          onClick={() => setPendingDelete(row)}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field id="connector-name" label={t("connectors.name")} value={form.name} onChange={(name) => setForm({ ...form, name })} />
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("connectors.type")}</span>
            <select
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`connectors.types.${type}`)}
                </option>
              ))}
            </select>
          </label>
          <Field label={t("connectors.host")} value={form.host} dir="ltr" onChange={(host) => setForm({ ...form, host })} />
          <Field label={t("connectors.port")} value={form.port} dir="ltr" onChange={(port) => setForm({ ...form, port })} />
          <Field label={t("connectors.database")} value={form.database} dir="ltr" onChange={(database) => setForm({ ...form, database })} />
          <Field label={t("connectors.username")} value={form.username} dir="ltr" onChange={(username) => setForm({ ...form, username })} />
          <Field
            label={t("connectors.password")}
            value={form.password}
            dir="ltr"
            placeholder={editing ? t("connectors.passwordKeep") : undefined}
            onChange={(password) => setForm({ ...form, password })}
            type="password"
          />
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("connectors.status")}</span>
            <select
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value === "INACTIVE" ? "INACTIVE" : "ACTIVE" })
              }
            >
              <option value="ACTIVE">{t("connectors.active")}</option>
              <option value="INACTIVE">{t("connectors.inactive")}</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.checked })} />
            {t("connectors.ssl")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.verifyCert}
              onChange={(e) => setForm({ ...form, verifyCert: e.target.checked })}
            />
            {t("connectors.verifyCert")}
          </label>
        </div>
        <Field
          label={t("connectors.options")}
          value={form.options}
          dir="ltr"
          placeholder={t("connectors.optionsHint")}
          onChange={(options) => setForm({ ...form, options })}
        />
        <Button disabled={busy === "save"} onClick={submit}>
          {busy === "save" ? t("common.processing") : editing ? t("common.save") : t("connectors.create")}
        </Button>
        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
        <ConfirmDialog
          open={Boolean(pendingDelete)}
          title={t("connectors.deleteTitle")}
          body={pendingDelete ? `${pendingDelete.name}. ${t("connectors.deleteBody")}` : ""}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          busy={Boolean(pendingDelete && busy === pendingDelete.id)}
          onConfirm={() => void remove()}
          onClose={() => setPendingDelete(null)}
        />
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  dir,
  type = "text",
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  dir?: "ltr" | "rtl";
  type?: string;
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        id={id}
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
        value={value}
        placeholder={placeholder}
        dir={dir}
        type={type}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
