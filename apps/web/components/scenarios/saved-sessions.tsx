"use client";

import { useCallback, useEffect, useState } from "react";
import { Cookie, KeyRound, Pencil, Save, Settings2, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";

/**
 * Saved browser sessions (cookies and page storage) for UI steps. The API
 * only ever sends summaries — names, domains, counts, status — never cookie
 * or storage values, so nothing secret can show up here.
 */
export type SavedSession = {
  id: string;
  name: string;
  domain: string;
  domains: string[];
  cookies: number;
  cookieNames: string[];
  storage: number;
  status: "valid" | "expired" | "unknown";
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What a UI step stores about its saved session. */
export type SessionChoice = { useSavedSession?: boolean; savedSessionId?: string; signedInText?: string };

const input = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";

export function useSavedSessions() {
  const [sessions, setSessions] = useState<SavedSession[] | null>(null);
  const reload = useCallback(async () => {
    setSessions(await api<SavedSession[]>("/ui-sessions").catch(() => []));
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { sessions, reload };
}

function StatusBadge({ status }: { status: SavedSession["status"] }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium",
        status === "valid" && "bg-success/10 text-success",
        status === "expired" && "bg-destructive/10 text-destructive",
        status === "unknown" && "bg-muted text-muted-foreground",
      )}
    >
      {t(`uiSessions.status.${status}`)}
    </span>
  );
}

/** Name, domain, cookies, storage and status of a saved session (no values). */
export function SessionSummary({ session }: { session: SavedSession }) {
  const { t, n, d } = useI18n();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-muted/40 p-2 text-[11px]">
      <dt className="text-muted-foreground">{t("uiSessions.name")}</dt>
      <dd className="font-medium">{session.name}</dd>
      <dt className="text-muted-foreground">{t("uiSessions.domain")}</dt>
      <dd className="font-mono" dir="ltr">
        {session.domain || "—"}
        {session.domains.length > 1 ? ` +${n(session.domains.length - 1)}` : ""}
      </dd>
      <dt className="text-muted-foreground">{t("uiSessions.cookies")}</dt>
      <dd title={session.cookieNames.join(", ")}>{n(session.cookies)}</dd>
      <dt className="text-muted-foreground">{t("uiSessions.storage")}</dt>
      <dd>{session.storage > 0 ? t("uiSessions.storageAvailable", { count: n(session.storage) }) : t("uiSessions.storageNone")}</dd>
      <dt className="text-muted-foreground">{t("uiSessions.statusLabel")}</dt>
      <dd className="flex items-center gap-1.5">
        <StatusBadge status={session.status} />
        {session.expiresAt ? <span className="text-muted-foreground">{t("uiSessions.expires", { when: d(session.expiresAt) })}</span> : null}
      </dd>
    </dl>
  );
}

/**
 * The "Authentication / Session" part of a UI step: reuse a saved session
 * (explicit switch), which one, how to tell it still signs in, and the way
 * to manage saved sessions.
 */
export function SessionPicker({ value, onChange }: { value: SessionChoice; onChange: (next: SessionChoice) => void }) {
  const { t } = useI18n();
  const { sessions, reload } = useSavedSessions();
  const [managing, setManaging] = useState(false);
  const selected = sessions?.find((item) => item.id === value.savedSessionId) ?? null;
  const missing = Boolean(value.savedSessionId && sessions && !selected);

  return (
    <section className="space-y-2 rounded-md border border-border p-3" aria-labelledby="ui-session-title">
      <h4 id="ui-session-title" className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRound className="h-3.5 w-3.5 text-primary" />
        {t("uiSessions.title")}
      </h4>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.useSavedSession === true}
          onChange={(event) => onChange({ ...value, useSavedSession: event.target.checked || undefined })}
        />
        <span>
          {t("uiSessions.reuse")}
          <span className="block text-[11px] text-muted-foreground">{t("uiSessions.reuseHint")}</span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className={cn(input, "h-7 w-auto min-w-48 flex-1")}
          aria-label={t("uiSessions.saved")}
          value={value.savedSessionId ?? ""}
          disabled={!sessions}
          onChange={(event) => onChange({ ...value, savedSessionId: event.target.value || undefined, ...(event.target.value ? { useSavedSession: true } : {}) })}
        >
          <option value="">{sessions?.length ? t("uiSessions.choose") : t("uiSessions.none")}</option>
          {sessions?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.domain}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => setManaging(true)}>
          <Settings2 className="h-3.5 w-3.5" />
          {t("uiSessions.manage")}
        </Button>
        {value.savedSessionId || value.useSavedSession ? (
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>
            <X className="h-3.5 w-3.5" />
            {t("uiSessions.clear")}
          </Button>
        ) : null}
      </div>
      {missing ? <p className="text-[11px] text-destructive">{t("uiSessions.missing")}</p> : null}
      {selected ? <SessionSummary session={selected} /> : null}
      {selected && value.useSavedSession !== true ? <p className="text-[11px] text-warning">{t("uiSessions.chosenButOff")}</p> : null}
      {value.useSavedSession ? (
        <label className="block space-y-1 text-xs">
          <span className="text-[11px] text-muted-foreground">{t("uiSessions.signedInText")}</span>
          <input
            className={input}
            dir="auto"
            placeholder={t("uiSessions.signedInTextHint")}
            value={value.signedInText ?? ""}
            onChange={(event) => onChange({ ...value, signedInText: event.target.value || undefined })}
          />
        </label>
      ) : null}
      <p className="text-[11px] text-muted-foreground">{t("uiSessions.howToSave")}</p>
      {managing ? (
        <ManageSessionsDialog
          sessions={sessions ?? []}
          onClose={() => setManaging(false)}
          onChanged={async (deletedId) => {
            await reload();
            if (deletedId && deletedId === value.savedSessionId) onChange({});
          }}
        />
      ) : null}
    </section>
  );
}

/** Rename and delete saved sessions (deleting removes their cookies and storage on the server). */
export function ManageSessionsDialog({ sessions, onClose, onChanged }: { sessions: SavedSession[]; onClose: () => void; onChanged: (deletedId?: string) => Promise<void> }) {
  const { t, err } = useI18n();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const work = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open title={t("uiSessions.manageTitle")} description={t("uiSessions.manageHint")} closeLabel={t("builder.panel.close")} onClose={onClose}>
      <div className="space-y-2">
        {sessions.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("uiSessions.none")}</p> : null}
        <ul className="space-y-2">
          {sessions.map((session) => (
            <li key={session.id} className="space-y-1.5 rounded-md border border-border p-2">
              {editing?.id === session.id ? (
                <div className="flex gap-1.5">
                  <input className={input} value={editing.name} aria-label={t("uiSessions.name")} autoFocus onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
                  <Button
                    size="sm"
                    disabled={busy || !editing.name.trim()}
                    onClick={() =>
                      void work(async () => {
                        await api(`/ui-sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ name: editing.name }) });
                        setEditing(null);
                        await onChanged();
                      })
                    }
                  >
                    {t("builder.settings.save")}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Cookie className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{session.name}</span>
                  <StatusBadge status={session.status} />
                  <Button size="sm" variant="ghost" aria-label={t("uiSessions.rename")} onClick={() => setEditing({ id: session.id, name: session.name })}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={t("uiSessions.delete")} onClick={() => setDeleting(session)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              )}
              <SessionSummary session={session} />
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {err(error)}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={Boolean(deleting)}
        title={t("uiSessions.deleteTitle")}
        body={t("uiSessions.deleteBody", { name: deleting?.name ?? "" })}
        confirmLabel={t("uiSessions.delete")}
        cancelLabel={t("common.cancel")}
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          void work(async () => {
            const id = deleting!.id;
            await api(`/ui-sessions/${id}`, { method: "DELETE" });
            setDeleting(null);
            await onChanged(id);
          })
        }
      />
    </Dialog>
  );
}

/**
 * In the recording dialog: keep the recording browser's current session
 * (after signing in there) under a name — cookies and page storage, or
 * cookies only — or save it over an existing one. Passwords are never part of it.
 */
export function SaveSessionPanel({ recordingId }: { recordingId: string }) {
  const { t, err } = useI18n();
  const { sessions, reload } = useSavedSessions();
  const [name, setName] = useState("");
  const [cookiesOnly, setCookiesOnly] = useState(false);
  const [replaceId, setReplaceId] = useState("");
  const [saved, setSaved] = useState<SavedSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<SavedSession>(`/scenarios/ui-recordings/${recordingId}/session`, {
        method: "POST",
        body: JSON.stringify(replaceId ? { replaceId, cookiesOnly } : { name: name.trim(), cookiesOnly }),
      });
      setSaved(result);
      setName("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
        <Save className="me-1 inline h-3.5 w-3.5 text-primary" />
        {t("uiSessions.saveCurrent")}
      </summary>
      <div className="space-y-2 px-3 pb-3 text-xs">
        <p className="text-[11px] text-muted-foreground">{t("uiSessions.saveCurrentHint")}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <select className={cn(input, "h-7 w-auto")} aria-label={t("uiSessions.saveAs")} value={replaceId} onChange={(event) => setReplaceId(event.target.value)}>
            <option value="">{t("uiSessions.saveAsNew")}</option>
            {sessions?.map((item) => (
              <option key={item.id} value={item.id}>
                {t("uiSessions.saveOver", { name: item.name })}
              </option>
            ))}
          </select>
          {!replaceId ? (
            <input className={cn(input, "h-7 w-48 flex-1")} placeholder={t("uiSessions.namePlaceholder")} aria-label={t("uiSessions.name")} value={name} onChange={(event) => setName(event.target.value)} />
          ) : null}
          <Button size="sm" disabled={busy || (!replaceId && !name.trim())} onClick={() => void save()}>
            <Save className="h-3.5 w-3.5" />
            {t("uiSessions.saveButton")}
          </Button>
        </div>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input type="checkbox" checked={cookiesOnly} onChange={(event) => setCookiesOnly(event.target.checked)} />
          {t("uiSessions.cookiesOnly")}
        </label>
        {saved ? (
          <div className="space-y-1">
            <p className="text-[11px] text-success">{t("uiSessions.savedNote")}</p>
            <SessionSummary session={saved} />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {err(error)}
          </p>
        ) : null}
      </div>
    </details>
  );
}
