"use client";

import { useEffect, useMemo, useState } from "react";
import { api, uploadFile } from "@/lib/api";
import { MediaGallery, MediaPicker, type MediaItem } from "@/components/media-attachments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

const LEVELS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "REOPENED"] as const;

type BugListItem = {
  id: string;
  title: string;
  severity: string;
  priority: string;
  status: string;
  assignee?: string | null;
  reporter?: string | null;
  actualResult?: string;
  jiraIssue?: { key: string } | null;
  testCase?: { title: string } | null;
  _count?: { comments: number };
};

type BugDetail = BugListItem & {
  description: string;
  reproductionSteps: string[];
  expectedResult: string;
  environment?: string | null;
  updatedAt: string;
  createdAt: string;
  comments: Array<{ id: string; author: string; content: string; createdAt: string }>;
  activities: Array<{ id: string; author: string; action: string; detail: string; createdAt: string }>;
};

type TestCase = { id: string; title: string };
type DetailTab = "details" | "comments" | "activity";

const EMPTY = {
  title: "",
  description: "",
  steps: "",
  expectedResult: "",
  actualResult: "",
  severity: "MEDIUM",
  priority: "MEDIUM",
  assignee: "",
  environment: "",
  testCaseId: "",
};

export default function BugsPage() {
  const { t, label, err, d, n } = useI18n();
  const toast = useToast();
  const [bugs, setBugs] = useState<BugListItem[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [author, setAuthor] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<DetailTab>("details");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [query, setQuery] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [bugMedia, setBugMedia] = useState<MediaItem[]>([]);

  const who = author.trim() || "QA";

  const reload = async () => {
    const [bugList, caseList] = await Promise.all([
      api<BugListItem[]>("/bugs"),
      api<TestCase[]>("/test-cases"),
    ]);
    setBugs(bugList);
    setCases(caseList);
    setLoadError(null);
  };

  const openBug = async (id: string) => {
    setSelectedId(id);
    setEditing(false);
    setTab("details");
    setBusy("detail");
    try {
      const next = await api<BugDetail>(`/bugs/${id}`);
      setDetail(next);
      const files = await api<MediaItem[]>(`/attachments?ownerKind=BUG&ownerId=${id}`).catch(() => []);
      setBugMedia(files);
    } catch (error) {
      const text = error instanceof Error ? err(error.message) : t("errors.loadFailed");
      toast.notify("error", text);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void reload().catch((error) => {
      const text = error instanceof Error ? err(error.message) : t("errors.loadFailed");
      setLoadError(text);
    });
  }, [err, t]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { ALL: bugs.length };
    for (const status of STATUSES) map[status] = 0;
    for (const bug of bugs) map[bug.status] = (map[bug.status] ?? 0) + 1;
    return map;
  }, [bugs]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return bugs.filter((bug) => {
      if (statusFilter !== "ALL" && bug.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        bug.title.toLowerCase().includes(needle) ||
        (bug.assignee ?? "").toLowerCase().includes(needle) ||
        (bug.reporter ?? "").toLowerCase().includes(needle)
      );
    });
  }, [bugs, query, statusFilter]);

  const create = async () => {
    setBusy("create");
    try {
      const created = await api<BugDetail>("/bugs", {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          description: form.description,
          reproductionSteps: lines(form.steps),
          expectedResult: form.expectedResult,
          actualResult: form.actualResult,
          severity: form.severity,
          priority: form.priority,
          assignee: form.assignee || undefined,
          environment: form.environment || undefined,
          testCaseId: form.testCaseId || undefined,
          reporter: who,
          author: who,
        }),
      });
      const uploadErrors: string[] = [];
      for (const file of pendingFiles) {
        try {
          await uploadFile("/attachments", file, { ownerKind: "BUG", ownerId: created.id });
        } catch (error) {
          uploadErrors.push(error instanceof Error ? err(error.message) : t("errors.failed"));
        }
      }
      setPendingFiles([]);
      setForm(EMPTY);
      setShowMore(false);
      setCreating(false);
      toast.notify("success", t("bugs.created"));
      if (uploadErrors[0]) toast.notify("error", uploadErrors[0]);
      await reload();
      await openBug(created.id);
    } catch (error) {
      toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!detail) return;
    setBusy("save");
    try {
      const next = await api<BugDetail>(`/bugs/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: detail.title,
          description: detail.description,
          reproductionSteps: detail.reproductionSteps,
          expectedResult: detail.expectedResult,
          actualResult: detail.actualResult,
          severity: detail.severity,
          priority: detail.priority,
          assignee: detail.assignee ?? "",
          author: who,
        }),
      });
      setDetail(next);
      setEditing(false);
      toast.notify(
        "success",
        next.activities.at(-1)?.action === "JIRA" ? t("bugs.jiraUnavailable") : t("bugs.saved"),
      );
      await reload();
    } catch (error) {
      toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (status: string) => {
    if (!detail || status === detail.status) return;
    setBusy(status);
    try {
      const next = await api<BugDetail>(`/bugs/${detail.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status, author: who }),
      });
      setDetail(next);
      toast.notify(
        "success",
        next.activities.at(-1)?.action === "JIRA" ? t("bugs.jiraUnavailable") : t("bugs.statusUpdated"),
      );
      await reload();
    } catch (error) {
      toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
    } finally {
      setBusy(null);
    }
  };

  const addComment = async () => {
    if (!detail || !comment.trim()) return;
    setBusy("comment");
    try {
      const next = await api<BugDetail>(`/bugs/${detail.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ content: comment, author: who }),
      });
      setDetail(next);
      setComment("");
      toast.notify(
        "success",
        next.activities.at(-1)?.action === "JIRA" ? t("bugs.jiraUnavailable") : t("bugs.commentAdded"),
      );
      await reload();
    } catch (error) {
      toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!detail) return;
    setBusy("delete");
    try {
      await api(`/bugs/${detail.id}`, { method: "DELETE" });
      setDetail(null);
      setSelectedId(null);
      setConfirmDelete(false);
      toast.notify("success", t("bugs.deleted"));
      await reload();
    } catch (error) {
      toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
    } finally {
      setBusy(null);
    }
  };

  const levelOptions = LEVELS.map((item) => ({ value: item, label: label("level", item) }));
  const steps = Array.isArray(detail?.reproductionSteps) ? detail.reproductionSteps : [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t("bugs.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("bugs.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("bugs.yourName")}</span>
            <input
              className="h-8 w-36 rounded-md border border-border bg-background px-2 text-sm"
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
            />
          </label>
          {!detail ? (
            <Button onClick={() => setCreating(true)}>{t("bugs.createBug")}</Button>
          ) : null}
        </div>
      </div>

      {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}

      {detail ? (
        <section className="rounded-md border border-border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDetail(null);
                setSelectedId(null);
                setEditing(false);
              }}
            >
              {t("bugs.backToList")}
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t("bugs.changeStatus")}</span>
                <select
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                  value={detail.status}
                  disabled={Boolean(busy)}
                  onChange={(event) => void setStatus(event.target.value)}
                >
                  <option value={detail.status}>{t(`bugs.statuses.${detail.status}`)}</option>
                  {nextStatuses(detail.status).map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status, t)}
                    </option>
                  ))}
                </select>
              </label>
              {editing ? (
                <>
                  <Button size="sm" disabled={busy === "save" || !detail.title.trim()} onClick={() => void save()}>
                    {busy === "save" ? t("common.processing") : t("bugs.save")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void openBug(detail.id)}>
                    {t("common.cancel")}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  {t("common.edit")}
                </Button>
              )}
              <Button size="sm" variant="destructive" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}>
                {t("common.delete")}
              </Button>
            </div>
          </div>

          <div className="space-y-3 px-3 py-3">
            {editing ? (
              <Field label={t("jira.titleField")} value={detail.title} onChange={(title) => setDetail({ ...detail, title })} />
            ) : (
              <h2 className="text-sm font-medium leading-6" dir="auto">
                {detail.title}
              </h2>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={statusTone(detail.status)}>{t(`bugs.statuses.${detail.status}`)}</Badge>
              <Badge className={levelTone(detail.severity)}>{label("level", detail.severity)}</Badge>
              <Badge>{label("level", detail.priority)}</Badge>
              {detail.assignee ? <span className="text-xs text-muted-foreground">{detail.assignee}</span> : null}
              {detail.jiraIssue?.key ? (
                <span className="font-mono text-[11px] text-muted-foreground dir-ltr">{detail.jiraIssue.key}</span>
              ) : null}
            </div>

            <div className="flex gap-1 border-b border-border">
              {(
                [
                  ["details", t("bugs.tabDetails")],
                  ["comments", `${t("bugs.comments")} ${n(detail.comments.length)}`],
                  ["activity", `${t("bugs.activity")} ${n(detail.activities.length)}`],
                ] as const
              ).map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  className={`border-b-2 px-2 py-1.5 text-xs ${
                    tab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground"
                  }`}
                  onClick={() => setTab(id)}
                >
                  {text}
                </button>
              ))}
            </div>

            {tab === "details" ? (
              editing ? (
                <div className="space-y-2">
                  <Area label={t("bugs.description")} value={detail.description} onChange={(description) => setDetail({ ...detail, description })} />
                  <Area
                    label={t("bugs.steps")}
                    hint={t("bugs.stepsHint")}
                    value={steps.join("\n")}
                    onChange={(value) => setDetail({ ...detail, reproductionSteps: lines(value) })}
                  />
                  <div className="grid gap-2 md:grid-cols-2">
                    <Area label={t("bugs.expectedResult")} value={detail.expectedResult} onChange={(expectedResult) => setDetail({ ...detail, expectedResult })} />
                    <Area label={t("bugs.actualResult")} value={detail.actualResult ?? ""} onChange={(actualResult) => setDetail({ ...detail, actualResult })} />
                  </div>
                  <div className="grid gap-2 md:grid-cols-3">
                    <Select label={t("bugs.severity")} value={detail.severity} onChange={(severity) => setDetail({ ...detail, severity })} options={levelOptions} />
                    <Select label={t("bugs.priority")} value={detail.priority} onChange={(priority) => setDetail({ ...detail, priority })} options={levelOptions} />
                    <Field label={t("bugs.assignee")} value={detail.assignee ?? ""} onChange={(assignee) => setDetail({ ...detail, assignee })} />
                  </div>
                </div>
              ) : (
                <div className="space-y-3 text-sm">
                  {detail.description ? <Block label={t("bugs.description")} text={detail.description} /> : null}
                  {steps.length > 0 ? (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("bugs.steps")}</div>
                      <ol className="mt-1 space-y-1">
                        {steps.map((step, index) => (
                          <li key={`${index}-${step}`} className="text-xs leading-5" dir="auto">
                            <span className="font-mono text-muted-foreground">{n(index + 1)}. </span>
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                  <div className="grid gap-2 md:grid-cols-2">
                    <Block label={t("bugs.expectedResult")} text={detail.expectedResult || "—"} />
                    <Block label={t("bugs.actualResult")} text={detail.actualResult || "—"} />
                  </div>
                  <MediaGallery
                    items={bugMedia}
                    removeLabel={t("common.delete")}
                    onRemove={(attachmentId) => {
                      const file = bugMedia.find((item) => item.id === attachmentId);
                      if (!window.confirm(t("common.confirmDelete", { name: file?.filename ?? "" }))) return;
                      void api(`/attachments/${attachmentId}`, { method: "DELETE" })
                        .then(() => setBugMedia((current) => current.filter((item) => item.id !== attachmentId)))
                        .catch((error) => {
                          toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
                        });
                    }}
                  />
                  <MediaPicker
                    label={t("common.media")}
                    hint={t("common.mediaHint")}
                    onFiles={(files) => {
                      void (async () => {
                        const created: MediaItem[] = [];
                        try {
                          for (const file of files) {
                            created.push(
                              await uploadFile<MediaItem>("/attachments", file, {
                                ownerKind: "BUG",
                                ownerId: detail.id,
                              }),
                            );
                          }
                          setBugMedia((current) => [...current, ...created]);
                        } catch (error) {
                          if (created.length > 0) setBugMedia((current) => [...current, ...created]);
                          toast.notify("error", error instanceof Error ? err(error.message) : t("errors.failed"));
                        }
                      })();
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("bugs.reporter")}: {detail.reporter || "QA"}
                    {" · "}
                    {d(detail.createdAt)}
                    {detail.testCase ? ` · ${t("bugs.linkedCase", { title: detail.testCase.title })}` : ""}
                  </p>
                </div>
              )
            ) : null}

            {tab === "comments" ? (
              <div className="space-y-2">
                {detail.comments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("bugs.noComments")}</p>
                ) : (
                  detail.comments.map((item) => (
                    <div key={item.id} className="rounded-md border border-border px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground">
                        {item.author} · {d(item.createdAt)}
                      </div>
                      <p className="mt-1 text-xs leading-5" dir="auto">{item.content}</p>
                    </div>
                  ))
                )}
                <div className="flex items-end gap-2">
                  <label className="block min-w-0 flex-1 space-y-1 text-xs">
                    <span className="text-muted-foreground">{t("bugs.addComment")}</span>
                    <input
                      className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                      placeholder={t("bugs.commentHint")}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                    />
                  </label>
                  <Button size="sm" disabled={busy === "comment" || !comment.trim()} onClick={() => void addComment()}>
                    {busy === "comment" ? t("common.processing") : t("bugs.addComment")}
                  </Button>
                </div>
              </div>
            ) : null}

            {tab === "activity" ? (
              <div className="space-y-1">
                {detail.activities.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("bugs.noActivity")}</p>
                ) : (
                  detail.activities.map((item) => (
                    <p key={item.id} className="text-xs leading-5 text-muted-foreground" dir="auto">
                      <span className="font-mono">{d(item.createdAt)}</span>
                      {" · "}
                      {item.author} {item.detail}
                    </p>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <FilterChip
              active={statusFilter === "ALL"}
              label={`${t("bugs.filterAll")} ${n(counts.ALL ?? 0)}`}
              onClick={() => setStatusFilter("ALL")}
            />
            {STATUSES.map((status) => (
              <FilterChip
                key={status}
                active={statusFilter === status}
                label={`${t(`bugs.statuses.${status}`)} ${n(counts[status] ?? 0)}`}
                onClick={() => setStatusFilter(status)}
              />
            ))}
            <input
              className="ms-auto h-7 w-full max-w-56 rounded-md border border-border bg-background px-2 text-xs"
              placeholder={t("bugs.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {bugs.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">{t("bugs.empty")}</p>
              <Button className="mt-3" size="sm" onClick={() => setCreating(true)}>
                {t("bugs.createBug")}
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("bugs.noResults")}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="px-2 py-1.5 text-start font-medium">{t("jira.titleField")}</th>
                    <th className="px-2 py-1.5 text-start font-medium">{t("bugs.status")}</th>
                    <th className="px-2 py-1.5 text-start font-medium">{t("bugs.severity")}</th>
                    <th className="px-2 py-1.5 text-start font-medium">{t("bugs.assignee")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((bug) => (
                    <tr
                      key={bug.id}
                      className={`cursor-pointer border-b border-border last:border-0 hover:bg-muted/30 ${
                        selectedId === bug.id ? "bg-muted/40" : ""
                      }`}
                      onClick={() => void openBug(bug.id)}
                    >
                      <td className="px-2 py-2">
                        <div dir="auto">{bug.title}</div>
                        {bug.jiraIssue?.key ? (
                          <div className="font-mono text-[10px] text-muted-foreground dir-ltr">{bug.jiraIssue.key}</div>
                        ) : null}
                      </td>
                      <td className="px-2 py-2">
                        <Badge className={statusTone(bug.status)}>{t(`bugs.statuses.${bug.status}`)}</Badge>
                      </td>
                      <td className="px-2 py-2">{label("level", bug.severity)}</td>
                      <td className="px-2 py-2 text-muted-foreground">{bug.assignee || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {creating ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-bug-title"
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-md border border-border bg-background p-4"
          >
            <h2 id="create-bug-title" className="text-sm font-medium">
              {t("bugs.createBug")}
            </h2>
            <div className="mt-3 space-y-2">
              <Field label={t("jira.titleField")} value={form.title} onChange={(title) => setForm({ ...form, title })} />
              <Area
                label={t("bugs.actualResult")}
                hint={t("bugs.actualResultHint")}
                value={form.actualResult}
                onChange={(actualResult) => setForm({ ...form, actualResult })}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <Select label={t("bugs.severity")} value={form.severity} onChange={(severity) => setForm({ ...form, severity })} options={levelOptions} />
                <Select label={t("bugs.priority")} value={form.priority} onChange={(priority) => setForm({ ...form, priority })} options={levelOptions} />
              </div>
              <button
                type="button"
                className="text-xs text-primary"
                onClick={() => setShowMore((value) => !value)}
              >
                {showMore ? t("bugs.fewerFields") : t("bugs.moreFields")}
              </button>
              {showMore ? (
                <div className="space-y-2">
                  <Area label={t("bugs.description")} value={form.description} onChange={(description) => setForm({ ...form, description })} />
                  <Area label={t("bugs.steps")} hint={t("bugs.stepsHint")} value={form.steps} onChange={(steps) => setForm({ ...form, steps })} />
                  <Area label={t("bugs.expectedResult")} value={form.expectedResult} onChange={(expectedResult) => setForm({ ...form, expectedResult })} />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label={t("bugs.assignee")} value={form.assignee} onChange={(assignee) => setForm({ ...form, assignee })} />
                    <Select
                      label={t("bugs.testCase")}
                      value={form.testCaseId}
                      onChange={(testCaseId) => setForm({ ...form, testCaseId })}
                      options={[{ value: "", label: t("common.select") }, ...cases.map((item) => ({ value: item.id, label: item.title }))]}
                    />
                  </div>
                </div>
              ) : null}
              <MediaPicker
                label={t("common.media")}
                hint={t("common.mediaHint")}
                disabled={busy === "create"}
                onFiles={(files) => setPendingFiles((current) => [...current, ...files])}
              />
              {pendingFiles.length > 0 ? (
                <ul className="space-y-1">
                  {pendingFiles.map((file) => (
                    <li key={`${file.name}-${file.size}`} className="truncate font-mono text-[11px] text-muted-foreground dir-ltr">
                      {file.name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setCreating(false);
                  setShowMore(false);
                  setPendingFiles([]);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button disabled={busy === "create" || !form.title.trim()} onClick={() => void create()}>
                {busy === "create" ? t("common.processing") : t("bugs.createBug")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title={t("bugs.deleteTitle")}
        body={t("bugs.deleteBody")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        busy={busy === "delete"}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function lines(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function nextStatuses(status: string) {
  const map: Record<string, string[]> = {
    OPEN: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
    IN_PROGRESS: ["RESOLVED", "CLOSED"],
    RESOLVED: ["CLOSED", "REOPENED"],
    CLOSED: ["REOPENED"],
    REOPENED: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  };
  return map[status] ?? [];
}

function statusLabel(status: string, t: (path: string) => string) {
  if (status === "IN_PROGRESS") return t("bugs.start");
  if (status === "RESOLVED") return t("bugs.resolve");
  if (status === "CLOSED") return t("bugs.closeBug");
  if (status === "REOPENED") return t("bugs.reopen");
  return t(`bugs.statuses.${status}`);
}

function statusTone(status: string) {
  if (status === "OPEN" || status === "REOPENED") return "border-destructive/40 bg-destructive/10 text-destructive normal-case";
  if (status === "IN_PROGRESS") return "border-primary/40 bg-primary/10 text-primary normal-case";
  if (status === "RESOLVED") return "border-success/40 bg-success/10 text-success normal-case";
  return "normal-case";
}

function levelTone(level: string) {
  if (level === "CRITICAL" || level === "HIGH") return "border-destructive/40 text-destructive normal-case";
  if (level === "MEDIUM") return "border-warning/40 text-warning normal-case";
  return "normal-case";
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`h-7 rounded-md border px-2 text-xs ${
        active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <p className="mt-1 text-xs leading-5" dir="auto">{text}</p>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Area({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <textarea
        className="min-h-16 w-full rounded-md border border-border bg-background p-2 text-sm"
        placeholder={hint}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value || "empty"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
