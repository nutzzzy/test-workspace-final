"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  FileSpreadsheet,
  Keyboard,
  Plug,
  Upload,
} from "lucide-react";
import { api, API_BASE } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressBanner } from "@/components/ui/progress";
import { useAsyncProgress } from "@/hooks/use-async-progress";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Issue = {
  id: string;
  key: string;
  title: string;
  description?: string;
  priority?: string | null;
  acceptanceCriteria?: Array<{ id: string; text: string }>;
  _count?: { testCases: number; risks: number; bugs: number };
};

type MethodId = "file" | "manual" | "api";

export default function JiraPage() {
  const { t, n, label, err } = useI18n();
  const progress = useAsyncProgress();
  const fileRef = useRef<HTMLInputElement>(null);
  const [method, setMethod] = useState<MethodId>("file");
  const [apiOpen, setApiOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [key, setKey] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualPriority, setManualPriority] = useState("");
  const [manualAc, setManualAc] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState("");
  const [editAc, setEditAc] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await api<Issue[]>("/jira/issues");
    setIssues(list);
    return list;
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const busy = progress.busy;

  const startEdit = (issue: Issue) => {
    setEditingId(issue.id);
    setEditKey(issue.key);
    setEditTitle(issue.title);
    setEditDescription(issue.description ?? "");
    setEditPriority(issue.priority ?? "");
    setEditAc((issue.acceptanceCriteria ?? []).map((item) => item.text).join("\n"));
    setNotice(null);
  };

  const saveEdit = async () => {
    if (!editingId || !editKey.trim() || !editTitle.trim()) return;
    setNotice(null);
    try {
      await api(`/jira/issues/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify({
          key: editKey.trim(),
          title: editTitle.trim(),
          description: editDescription,
          priority: editPriority.trim() || undefined,
          acceptanceCriteria: editAc
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        }),
      });
      setEditingId(null);
      setNotice(t("jira.updated"));
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "REQUEST_FAILED");
    }
  };

  const removeIssue = async (issue: Issue) => {
    if (!window.confirm(t("jira.confirmDelete", { key: issue.key }))) return;
    setNotice(null);
    try {
      await api(`/jira/issues/${issue.id}`, { method: "DELETE" });
      if (editingId === issue.id) setEditingId(null);
      setNotice(t("jira.deleted"));
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "REQUEST_FAILED");
    }
  };

  const onUpload = async (file: File) => {
    setMethod("file");
    try {
      await progress.run(
        [
          { to: 12, label: t("jira.progressPrepare") },
          { to: 35, label: t("jira.progressUpload") },
          { to: 58, label: t("jira.progressParse") },
          { to: 78, label: t("jira.progressSave") },
          { to: 92, label: t("jira.progressReload") },
        ],
        async () => {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch(`${API_BASE}/jira/import-file`, {
            method: "POST",
            body: form,
          });
          const text = await res.text();
          if (!res.ok) throw new Error(text || `Upload failed (${res.status})`);
          const data = JSON.parse(text) as {
            importedCount: number;
            keys: string[];
          };
          await reload();
          return data;
        },
        {
          successLabel: (data) =>
            t("jira.successFile", { count: data.importedCount }),
        },
      );
    } catch {
      // banner
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onManual = async () => {
    setMethod("manual");
    try {
      await progress.run(
        [
          { to: 20, label: t("jira.progressPrepare") },
          { to: 55, label: t("jira.progressManual") },
          { to: 90, label: t("jira.progressReload") },
        ],
        async () => {
          const acceptanceCriteria = manualAc
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          await api("/jira/manual", {
            method: "POST",
            body: JSON.stringify({
              key: manualKey,
              title: manualTitle,
              description: manualDescription,
              priority: manualPriority,
              acceptanceCriteria,
            }),
          });
          setManualTitle("");
          setManualDescription("");
          setManualAc("");
          await reload();
        },
        { successLabel: t("jira.successManual") },
      );
    } catch {
      // banner
    }
  };

  const onApiImport = async () => {
    setMethod("api");
    setApiOpen(true);
    try {
      await progress.run(
        [
          { to: 20, label: t("jira.progressPrepare") },
          { to: 50, label: t("jira.progressApi") },
          { to: 88, label: t("jira.progressReload") },
        ],
        async () => {
          await api("/jira/import", {
            method: "POST",
            body: JSON.stringify({ key }),
          });
          await reload();
        },
        { successLabel: t("jira.successApi") },
      );
    } catch {
      // banner + api hint
    }
  };

  const methods: Array<{
    id: MethodId;
    icon: typeof FileSpreadsheet;
    title: string;
    hint: string;
    recommended?: boolean;
  }> = [
    {
      id: "file",
      icon: FileSpreadsheet,
      title: t("jira.stepFile"),
      hint: t("jira.stepFileHint"),
      recommended: true,
    },
    {
      id: "manual",
      icon: Keyboard,
      title: t("jira.stepManual"),
      hint: t("jira.stepManualHint"),
    },
  ];

  const successText = progress.success;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {t("jira.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t("jira.subtitle")}
          </p>
        </div>
        <Badge className="font-mono text-[10px]">
          {t("jira.issuesCount", { count: n(issues.length) })}
        </Badge>
      </div>

      <ProgressBanner
        active={progress.active}
        value={progress.percent}
        label={progress.label || t("jira.processing")}
        error={progress.error}
        success={successText}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("jira.howTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t("jira.howHint")}</p>
          <div className="grid gap-2 md:grid-cols-2">
            {methods.map((m) => {
              const Icon = m.icon;
              const active = method === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setMethod(m.id)}
                  className={cn(
                    "rounded-md border px-3 py-2.5 text-start transition-colors",
                    active
                      ? "border-primary/50 bg-primary/10"
                      : "border-border bg-background hover:bg-accent",
                    busy && "opacity-60",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-primary" />
                    <span className="text-sm font-medium">{m.title}</span>
                    {m.recommended ? (
                      <Badge className="ms-auto text-[9px]">★</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    {m.hint}
                  </p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {method === "file" ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("jira.stepFile")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t("jira.columnsHint")}:{" "}
              <span className="dir-ltr inline-block font-mono text-[10px] text-foreground/80">
                key · title · description · issue_type · priority · labels ·
                acceptance_criteria
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <a href={`${API_BASE}/jira/import-template?format=xlsx`}>
                <Button type="button" variant="secondary" disabled={busy}>
                  {t("jira.downloadTemplate")} · Excel
                </Button>
              </a>
              <a href={`${API_BASE}/jira/import-template?format=csv`}>
                <Button type="button" variant="outline" disabled={busy}>
                  {t("jira.downloadTemplate")} · CSV
                </Button>
              </a>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUpload(file);
              }}
            />
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void onUpload(file);
              }}
              className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center transition-colors",
                dragOver
                  ? "border-primary bg-primary/10"
                  : "border-border bg-muted/30",
                busy && "pointer-events-none opacity-60",
              )}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t("jira.dragDrop")}</p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {t("jira.chooseFile")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {method === "manual" ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("jira.stepManual")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid gap-2 md:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">{t("jira.issueKey")}</span>
                <input
                  className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-sm"
                  dir="ltr"
                  value={manualKey}
                  onChange={(e) => setManualKey(e.target.value)}
                  disabled={busy}
                  placeholder="PROJ-123"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">{t("jira.priority")}</span>
                <input
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={manualPriority}
                  onChange={(e) => setManualPriority(e.target.value)}
                  disabled={busy}
                  placeholder={t("jira.priority")}
                />
              </label>
            </div>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("jira.titleField")}</span>
              <input
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                disabled={busy}
                placeholder={t("jira.titlePlaceholder")}
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("jira.descriptionField")}
              </span>
              <textarea
                className="min-h-16 w-full rounded-md border border-border bg-background p-2 text-sm"
                value={manualDescription}
                onChange={(e) => setManualDescription(e.target.value)}
                disabled={busy}
                placeholder={t("jira.descriptionPlaceholder")}
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("jira.acceptanceCriteria")}
              </span>
              <textarea
                className="min-h-20 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
                value={manualAc}
                onChange={(e) => setManualAc(e.target.value)}
                disabled={busy}
                placeholder={t("jira.acPlaceholder")}
              />
            </label>
            <Button
              disabled={busy || !manualTitle.trim() || !manualKey.trim()}
              onClick={() => void onManual()}
            >
              {t("jira.saveManual")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-start"
          onClick={() => setApiOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <Plug className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("jira.stepApi")}
            </span>
          </div>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              apiOpen && "rotate-180",
            )}
          />
        </button>
        {apiOpen ? (
          <CardContent className="space-y-2 border-t border-border">
            <p className="text-xs text-muted-foreground">
              {t("jira.stepApiHint")}
            </p>
            {progress.error ? (
              <p className="text-[11px] text-warning">{t("jira.apiBlockedHint")}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm"
                dir="ltr"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                disabled={busy}
                placeholder="PROJ-123"
              />
              <Button disabled={busy} onClick={() => void onApiImport()}>
                {t("jira.importApi")}
              </Button>
            </div>
          </CardContent>
        ) : null}
      </Card>

      {notice ? (
        <p className="text-xs text-muted-foreground">{err(notice)}</p>
      ) : null}

      {editingId ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("jira.editIssue")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid gap-2 md:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">{t("jira.issueKey")}</span>
                <input
                  className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-sm"
                  dir="ltr"
                  value={editKey}
                  onChange={(e) => setEditKey(e.target.value)}
                  placeholder="PROJ-123"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">{t("jira.priority")}</span>
                <input
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={editPriority}
                  onChange={(e) => setEditPriority(e.target.value)}
                  placeholder={t("jira.priority")}
                />
              </label>
            </div>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("jira.titleField")}</span>
              <input
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder={t("jira.titlePlaceholder")}
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("jira.descriptionField")}
              </span>
              <textarea
                className="min-h-16 w-full rounded-md border border-border bg-background p-2 text-sm"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t("jira.descriptionPlaceholder")}
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("jira.acceptanceCriteria")}
              </span>
              <textarea
                className="min-h-20 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
                value={editAc}
                onChange={(e) => setEditAc(e.target.value)}
                placeholder={t("jira.acPlaceholder")}
              />
            </label>
            <div className="flex gap-2">
              <Button
                disabled={!editKey.trim() || !editTitle.trim()}
                onClick={() => void saveEdit()}
              >
                {t("common.save")}
              </Button>
              <Button variant="outline" onClick={() => setEditingId(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("jira.importedIssues")}</CardTitle>
          {issues.length > 0 ? (
            <span className="text-[10px] text-muted-foreground">
              {t("jira.nextStep")}
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {issues.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t("common.empty")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-start font-medium">
                      {t("common.key")}
                    </th>
                    <th className="px-3 py-2 text-start font-medium">
                      {t("jira.titleField")}
                    </th>
                    <th className="px-3 py-2 text-start font-medium">
                      {t("jira.priority")}
                    </th>
                    <th className="px-3 py-2 text-start font-medium font-mono">
                      {t("jira.testCases")}
                    </th>
                    <th className="px-3 py-2 text-start font-medium font-mono">
                      {t("jira.risks")}
                    </th>
                    <th className="px-3 py-2 text-start font-medium font-mono">
                      {t("jira.bugs")}
                    </th>
                    <th className="px-3 py-2 text-end font-medium">
                      {t("common.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((issue) => (
                    <tr
                      key={issue.id}
                      className="border-b border-border/60 last:border-0 hover:bg-accent/40"
                    >
                      <td className="px-3 py-2">
                        <span className="dir-ltr inline-block font-mono text-xs text-primary">
                          {issue.key}
                        </span>
                      </td>
                      <td className="max-w-[280px] truncate px-3 py-2">
                        {issue.title}
                      </td>
                      <td className="px-3 py-2">
                        {issue.priority ? (
                          <Badge>{label("level", issue.priority)}</Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {n(issue._count?.testCases ?? 0)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {n(issue._count?.risks ?? 0)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {n(issue._count?.bugs ?? 0)}
                      </td>
                      <td className="px-3 py-2 text-end">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => startEdit(issue)}
                          >
                            {t("common.edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => void removeIssue(issue)}
                          >
                            {t("common.delete")}
                          </Button>
                          <Link href={`/workspace/${issue.key}`}>
                            <Button size="sm" variant="outline">
                              {t("jira.openWorkspace")}
                            </Button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
