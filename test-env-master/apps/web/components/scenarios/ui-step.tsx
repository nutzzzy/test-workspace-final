"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  Eye,
  Globe,
  Keyboard,
  ListChecks,
  MinusCircle,
  MousePointerClick,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Type,
  Video,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BidiText } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { Step, StepOutput } from "@/components/scenarios/builder-types";

/** Mirrors the API's UI action (apps/api/src/scenario-engine/ui/ui-types.ts). */
export type UiAction = {
  id: string;
  kind: "navigate" | "click" | "fill" | "select" | "check" | "uncheck" | "press" | "waitForText" | "assertText" | "assertUrl";
  target?: { candidates: Array<{ kind: string; value: string; name?: string }>; fingerprint: Record<string, unknown>; learned?: number };
  value?: string;
  secret?: boolean;
  optionLabel?: string;
  url?: string;
  tab?: number;
  frameUrl?: string;
  optional?: boolean;
  label?: string;
};

export type UiActionResult = {
  id: string;
  kind: UiAction["kind"];
  label: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  durationMs: number;
  how?: string;
  healed?: boolean;
  error?: string;
  optional?: boolean;
};

export type UiOutput = StepOutput & {
  kind?: "ui";
  url?: string;
  title?: string;
  actions?: UiActionResult[];
  pageErrors?: string[];
  screenshot?: string;
  signedIn?: SignedIn;
  values?: Array<{ path: string; key: string; display: string; secret?: boolean }>;
};

type SignedIn = { cookies: string[]; headers: string[]; storage: string[]; guessed?: string[]; missing?: string[] };

type Recording = {
  id: string;
  state: "recording" | "stopped";
  error: string | null;
  startUrl: string;
  actions: Array<{ id: string; kind: UiAction["kind"]; label: string; secret?: boolean }>;
  /** The earlier steps that ran so the browser opened signed in. */
  prepared?: { status: string; steps: Array<{ name: string; status: string; error?: string }>; signedIn: SignedIn | null } | null;
};

/** A storage entry the step puts into the page before it loads (where the app keeps its token). */
export type StorageSeed = {
  area: "localStorage" | "sessionStorage";
  key: string;
  value?: string;
  source?: { stepId?: string; stepName?: string; orderIndex: number; path: string };
  jsonTemplate?: string;
};

/** A value an earlier step produced in its last run (masked when secret). */
export type EarlierValue = { stepId?: string; stepName: string; orderIndex: number; path: string; key: string; display: string };

const SECRET = "••••••";
const input = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";
const VALUE_KINDS: UiAction["kind"][] = ["navigate", "fill", "select", "press", "waitForText", "assertText", "assertUrl"];

export function actionIcon(kind: UiAction["kind"]) {
  switch (kind) {
    case "navigate":
      return Globe;
    case "click":
      return MousePointerClick;
    case "fill":
      return Type;
    case "select":
      return ListChecks;
    case "check":
    case "uncheck":
      return CheckCircle2;
    case "press":
      return Keyboard;
    default:
      return Eye;
  }
}

export function uiActions(config: Record<string, unknown>): UiAction[] {
  return Array.isArray(config.actions) ? (config.actions as UiAction[]) : [];
}

/**
 * Record a UI step: a browser opens on this computer at the start URL; what
 * the user does there is listed here live. Saved as a new step, or into the
 * step it was started from (added to the end, or replacing its actions).
 */
export function UiRecordDialog({
  scenarioId,
  step,
  earlierSteps,
  onClose,
  onSaved,
}: {
  scenarioId: string;
  step?: Step | null;
  /** Steps that run before this one (they can sign the browser in). */
  earlierSteps: number;
  onClose: () => void;
  onSaved: (step: Step) => void | Promise<void>;
}) {
  const { t, n, err } = useI18n();
  const existing = step ? uiActions(step.config) : [];
  const lastUrl = [...existing].reverse().find((action) => action.url)?.url;
  const [name, setName] = useState("");
  const [startUrl, setStartUrl] = useState(String(step?.config.startUrl ?? ""));
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [signedIn, setSignedIn] = useState(true);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const recordingId = recording?.id;
  const active = recording?.state === "recording";

  // Live list while recording; stops by itself when the browser is closed or the badge's stop is pressed.
  useEffect(() => {
    if (!recordingId || !active) return;
    const timer = setInterval(() => {
      void api<Recording>(`/scenarios/ui-recordings/${recordingId}`)
        .then(setRecording)
        .catch(() => undefined);
    }, 800);
    return () => clearInterval(timer);
  }, [recordingId, active]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [recording?.actions.length]);

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

  const start = () =>
    work(async () => {
      const url = /^https?:\/\//i.test(startUrl.trim()) ? startUrl.trim() : `https://${startUrl.trim()}`;
      setStartUrl(url);
      setRecording(
        await api<Recording>(`/scenarios/${scenarioId}/ui-recordings`, {
          method: "POST",
          body: JSON.stringify({ startUrl: url, signedIn: earlierSteps > 0 && signedIn, ...(step ? { stepId: step.id } : {}) }),
        }),
      );
    });

  const stop = () => work(async () => setRecording(await api<Recording>(`/scenarios/ui-recordings/${recording!.id}/stop`, { method: "POST", body: "{}" })));

  const save = () =>
    work(async () => {
      const saved = await api<Step>(`/scenarios/ui-recordings/${recording!.id}/save`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || undefined, mode }),
      });
      await onSaved(saved);
      onClose();
    });

  const close = () => {
    if (recording) void api(`/scenarios/ui-recordings/${recording.id}/discard`, { method: "POST", body: "{}" }).catch(() => undefined);
    onClose();
  };

  const count = recording?.actions.length ?? 0;
  return (
    <Dialog
      open
      title={step ? t("uiStep.recordMoreTitle") : t("uiStep.recordTitle")}
      description={t("uiStep.recordHint")}
      closeLabel={t("builder.panel.close")}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {recording ? t("uiStep.discard") : t("common.cancel")}
          </Button>
          {!recording ? (
            <Button disabled={busy || !startUrl.trim()} onClick={() => void start()}>
              <Video className="h-3.5 w-3.5" />
              {t("uiStep.start")}
            </Button>
          ) : active ? (
            <Button variant="destructive" disabled={busy} onClick={() => void stop()}>
              <Square className="h-3.5 w-3.5" />
              {t("uiStep.stop")}
            </Button>
          ) : (
            <Button disabled={busy || count === 0} onClick={() => void save()}>
              {step ? t("uiStep.saveInto") : t("uiStep.save", { count: n(count) })}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {!recording ? (
          <>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("uiStep.startUrl")}</span>
              <input
                className={cn(input, "font-mono")}
                dir="ltr"
                placeholder="https://app.example.com/login"
                value={startUrl}
                autoFocus
                onChange={(event) => setStartUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && startUrl.trim()) void start();
                }}
              />
            </label>
            {step && lastUrl && lastUrl !== startUrl ? (
              <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setStartUrl(lastUrl)}>
                {t("uiStep.continueFrom")} <span className="font-mono" dir="ltr">{lastUrl}</span>
              </button>
            ) : null}
            {!step ? (
              <label className="block space-y-1 text-xs">
                <span className="text-muted-foreground">{t("builder.settings.name")}</span>
                <input className={input} value={name} placeholder={t("uiStep.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
              </label>
            ) : (
              <fieldset className="flex flex-wrap gap-3 text-xs">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={mode === "append"} onChange={() => setMode("append")} />
                  {t("uiStep.append", { count: n(existing.length) })}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />
                  {t("uiStep.replace")}
                </label>
              </fieldset>
            )}
            {earlierSteps > 0 ? (
              <label className="flex items-start gap-2 rounded-md border border-border p-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={signedIn} onChange={(event) => setSignedIn(event.target.checked)} />
                <span>
                  {t("uiStep.signedInRecord", { count: n(earlierSteps) })}
                  <span className="block text-[11px] text-muted-foreground">{t("uiStep.signedInRecordHint")}</span>
                </span>
              </label>
            ) : null}
            <ul className="list-disc space-y-0.5 ps-4 text-[11px] text-muted-foreground">
              <li>{t("uiStep.tip1")}</li>
              <li>{t("uiStep.tip2")}</li>
              <li>{t("uiStep.tip3")}</li>
            </ul>
          </>
        ) : (
          <>
            <p className={cn("flex items-center gap-2 text-xs", active ? "text-destructive" : "text-muted-foreground")} role="status">
              {active ? <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" aria-hidden /> : null}
              {active ? t("uiStep.recording") : t("uiStep.stopped", { count: n(count) })}
            </p>
            {recording.error ? <p className="text-xs text-warning">{err(recording.error)}</p> : null}
            {recording.prepared ? <PreparedNote prepared={recording.prepared} /> : null}
            {count === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("uiStep.waiting")}</p>
            ) : (
              <ol ref={listRef} className="max-h-72 space-y-1 overflow-auto" aria-label={t("uiStep.actions")}>
                {recording.actions.map((action, index) => {
                  const Icon = actionIcon(action.kind);
                  return (
                    <li key={action.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                      <span className="w-5 shrink-0 text-end font-mono text-[10px] text-muted-foreground">{n(index + 1)}</span>
                      <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <BidiText text={action.label} className="min-w-0 flex-1 truncate" />
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {err(error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Which earlier steps ran for a signed-in recording, and what the browser got from them. */
function PreparedNote({ prepared }: { prepared: NonNullable<Recording["prepared"]> }) {
  const { t, n, err, label } = useI18n();
  const failed = prepared.steps.find((item) => item.status !== "PASSED" && item.status !== "SKIPPED");
  return (
    <div className={cn("space-y-1 rounded-md border px-2 py-1.5 text-[11px]", failed ? "border-warning/50 bg-warning/5" : "border-primary/40 bg-primary/5")}>
      <p>{t("uiStep.preparedSteps", { count: n(prepared.steps.length) })}</p>
      {failed ? (
        <p className="text-warning">
          {t("uiStep.preparedFailed", { name: failed.name, status: label("status", failed.status) })}
          {failed.error ? ` — ${err(failed.error)}` : ""}
        </p>
      ) : null}
      {prepared.signedIn ? <SignedInSummary signedIn={prepared.signedIn} /> : null}
    </div>
  );
}

/** Names (never values) of the cookies, headers and storage entries the browser started with. */
export function SignedInSummary({ signedIn }: { signedIn: SignedIn }) {
  const { t } = useI18n();
  const empty = !signedIn.cookies.length && !signedIn.headers.length && !signedIn.storage.length && !signedIn.guessed?.length;
  return (
    <div className="space-y-0.5">
      {empty ? <p className="text-muted-foreground">{t("uiStep.signedInNothing")}</p> : null}
      {signedIn.cookies.length ? (
        <p>
          <span className="text-muted-foreground">{t("uiStep.signedInCookies")}: </span>
          <span className="font-mono" dir="ltr">{signedIn.cookies.join(", ")}</span>
        </p>
      ) : null}
      {signedIn.headers.length ? (
        <p>
          <span className="text-muted-foreground">{t("uiStep.signedInHeaders")}: </span>
          <span className="font-mono" dir="ltr">{signedIn.headers.join(", ")}</span>
        </p>
      ) : null}
      {signedIn.storage.length ? (
        <p>
          <span className="text-muted-foreground">{t("uiStep.signedInStorage")}: </span>
          <span className="font-mono" dir="ltr">{signedIn.storage.join(", ")}</span>
        </p>
      ) : null}
      {signedIn.guessed?.length ? (
        <p>
          <span className="text-muted-foreground">{t("uiStep.signedInGuessed")}: </span>
          <span className="font-mono" dir="ltr">{signedIn.guessed.map((item) => item.replace(/^localStorage\./, "")).join(", ")}</span>
        </p>
      ) : null}
      {signedIn.missing?.length ? (
        <p className="text-warning">
          {t("uiStep.signedInMissing")}: <span className="font-mono" dir="ltr">{signedIn.missing.join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The Actions tab of a UI step: what it does, editable; record more. */
export function UiActionsTab({
  step,
  earlierValues,
  onSave,
  onRecordMore,
}: {
  step: Step;
  /** Values earlier steps produced in the last run, to put into page storage. */
  earlierValues: EarlierValue[];
  onSave: (config: Record<string, unknown>) => Promise<void>;
  onRecordMore: () => void;
}) {
  const { t, n } = useI18n();
  const [startUrl, setStartUrl] = useState(String(step.config.startUrl ?? ""));
  const [actions, setActions] = useState<UiAction[]>(uiActions(step.config));
  const [timeout, setTimeoutValue] = useState(String(step.config.actionTimeoutMs ?? 15000));
  const [newSession, setNewSession] = useState(step.config.newSession === true);
  const [failOnPageError, setFailOnPageError] = useState(step.config.failOnPageError !== false);
  const savedSession = (step.config.session ?? {}) as { fromEarlierSteps?: boolean; storage?: StorageSeed[] };
  const [fromEarlier, setFromEarlier] = useState(savedSession.fromEarlierSteps !== false);
  const [storage, setStorage] = useState<StorageSeed[]>(savedSession.storage ?? []);
  const patchSeed = (index: number, value: Partial<StorageSeed>) => {
    setStorage(storage.map((item, at) => (at === index ? { ...item, ...value } : item)));
    setDirty(true);
  };
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = (next: UiAction[]) => {
    setActions(next);
    setDirty(true);
  };
  const patch = (index: number, value: Partial<UiAction>) => change(actions.map((action, at) => (at === index ? { ...action, ...value } : action)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...actions];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    change(next);
  };
  const add = (kind: UiAction["kind"]) =>
    change([...actions, { id: crypto.randomUUID(), kind, value: "", label: t(`uiStep.kinds.${kind}`) }]);

  const save = async () => {
    setBusy(true);
    try {
      const timeoutMs = Number(timeout);
      await onSave({
        ...step.config,
        startUrl: startUrl.trim(),
        actions,
        actionTimeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 15000,
        newSession: newSession || undefined,
        failOnPageError: failOnPageError ? undefined : false,
        session:
          fromEarlier && storage.length === 0
            ? undefined
            : { ...(fromEarlier ? {} : { fromEarlierSteps: false }), ...(storage.length ? { storage: storage.filter((item) => item.key.trim()) } : {}) },
      });
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-[11px] text-muted-foreground">{t("uiStep.startUrl")}</span>
          <input
            className={cn(input, "font-mono")}
            dir="ltr"
            value={startUrl}
            onChange={(event) => {
              setStartUrl(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <Button size="sm" variant="outline" onClick={onRecordMore}>
          <Video className="h-3.5 w-3.5" />
          {t("uiStep.recordMore")}
        </Button>
      </div>

      {actions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("uiStep.noActions")}</p>
      ) : (
        <ol className="space-y-1.5" aria-label={t("uiStep.actions")}>
          {actions.map((action, index) => {
            const Icon = actionIcon(action.kind);
            const hasValue = VALUE_KINDS.includes(action.kind);
            const locator = action.target?.candidates[action.target.learned ?? 0] ?? action.target?.candidates[0];
            return (
              <li key={action.id} className={cn("space-y-1.5 rounded-md border px-2 py-1.5", action.optional ? "border-dashed border-border" : "border-border")}>
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-end font-mono text-[10px] text-muted-foreground">{n(index + 1)}</span>
                  <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={t(`uiStep.kinds.${action.kind}`)} />
                  <input
                    className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-xs hover:border-border focus:border-border"
                    dir="auto"
                    value={action.label ?? ""}
                    aria-label={t("uiStep.description")}
                    onChange={(event) => patch(index, { label: event.target.value })}
                  />
                  <span className="flex shrink-0">
                    <IconButton label={t("builder.flow.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton label={t("builder.flow.moveDown")} disabled={index === actions.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton label={t("builder.flow.delete")} danger onClick={() => change(actions.filter((_, at) => at !== index))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 ps-7">
                  {hasValue ? (
                    <input
                      className={cn(input, "h-7 max-w-72 flex-1", action.kind === "navigate" || action.kind === "assertUrl" ? "font-mono" : "")}
                      dir={action.kind === "navigate" || action.kind === "assertUrl" ? "ltr" : "auto"}
                      type={action.secret ? "password" : "text"}
                      autoComplete="off"
                      placeholder={action.secret ? t("uiStep.secretKept") : t(`uiStep.valueHint.${action.kind}`)}
                      value={action.kind === "navigate" ? (action.url ?? action.value ?? "") : action.secret && action.value === SECRET ? "" : (action.value ?? "")}
                      aria-label={t("uiStep.value")}
                      onChange={(event) =>
                        patch(index, action.kind === "navigate" ? { url: event.target.value } : { value: event.target.value })
                      }
                    />
                  ) : null}
                  {locator ? (
                    <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" dir="ltr" title={action.target!.candidates.map((item) => `${item.kind}: ${item.value}${item.name ? ` "${item.name}"` : ""}`).join("\n")}>
                      {locator.kind === "role" ? `${locator.value} "${locator.name ?? ""}"` : locator.value}
                      {action.target!.candidates.length > 1 ? ` +${n(action.target!.candidates.length - 1)}` : ""}
                    </span>
                  ) : null}
                  <label className="ms-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                    <input type="checkbox" checked={action.optional === true} onChange={(event) => patch(index, { optional: event.target.checked || undefined })} />
                    {t("uiStep.optional")}
                  </label>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(["assertText", "assertUrl", "waitForText", "navigate"] as const).map((kind) => (
          <Button key={kind} size="sm" variant="ghost" onClick={() => add(kind)}>
            <Plus className="h-3.5 w-3.5" />
            {t(`uiStep.add.${kind}`)}
          </Button>
        ))}
      </div>

      <details className="rounded-md border border-border" open={storage.length > 0 || !fromEarlier}>
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t("uiStep.signIn")}</summary>
        <div className="space-y-3 px-3 pb-3">
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={fromEarlier}
              onChange={(event) => {
                setFromEarlier(event.target.checked);
                setDirty(true);
              }}
            />
            <span>
              {t("uiStep.fromEarlier")}
              <span className="block text-[11px] text-muted-foreground">{t("uiStep.fromEarlierHint")}</span>
            </span>
          </label>
          <div className="space-y-1.5">
            <p className="text-xs">{t("uiStep.storageTitle")}</p>
            <p className="text-[11px] text-muted-foreground">{t("uiStep.storageHint")}</p>
            {storage.map((item, index) => {
              const mode = item.source ? "earlier" : item.value ? "text" : "auto";
              return (
                <div key={index} className="space-y-1.5 rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      className={cn(input, "h-7 w-36")}
                      aria-label={t("uiStep.storageArea")}
                      value={item.area}
                      onChange={(event) => patchSeed(index, { area: event.target.value as StorageSeed["area"] })}
                    >
                      <option value="localStorage">localStorage</option>
                      <option value="sessionStorage">sessionStorage</option>
                    </select>
                    <input
                      className={cn(input, "h-7 w-40 flex-1 font-mono")}
                      dir="ltr"
                      placeholder="auth_token"
                      aria-label={t("uiStep.storageKey")}
                      value={item.key}
                      onChange={(event) => patchSeed(index, { key: event.target.value })}
                    />
                    <IconButton label={t("builder.flow.delete")} danger onClick={() => { setStorage(storage.filter((_, at) => at !== index)); setDirty(true); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      className={cn(input, "h-7 w-48")}
                      aria-label={t("uiStep.storageValue")}
                      value={mode === "earlier" ? `earlier:${item.source!.orderIndex}:${item.source!.path}` : mode}
                      onChange={(event) => {
                        const choice = event.target.value;
                        if (choice === "auto") patchSeed(index, { source: undefined, value: undefined });
                        else if (choice === "text") patchSeed(index, { source: undefined, value: item.value || "{{accessToken}}" });
                        else {
                          const picked = earlierValues.find((value) => `earlier:${value.orderIndex}:${value.path}` === choice);
                          if (picked) patchSeed(index, { value: undefined, source: { stepId: picked.stepId, stepName: picked.stepName, orderIndex: picked.orderIndex, path: picked.path } });
                        }
                      }}
                    >
                      <option value="auto">{t("uiStep.valueAuto")}</option>
                      <option value="text">{t("uiStep.valueText")}</option>
                      {earlierValues.map((value) => (
                        <option key={`${value.orderIndex}:${value.path}`} value={`earlier:${value.orderIndex}:${value.path}`}>
                          {t("builder.flow.step", { n: n(value.orderIndex + 1) })} · {value.path.replace(/^response\.body\./, "")} · {value.display}
                        </option>
                      ))}
                    </select>
                    {mode === "text" ? (
                      <input
                        className={cn(input, "h-7 min-w-40 flex-1 font-mono")}
                        dir="ltr"
                        aria-label={t("uiStep.value")}
                        value={item.value ?? ""}
                        onChange={(event) => patchSeed(index, { value: event.target.value })}
                      />
                    ) : null}
                  </div>
                  <input
                    className={cn(input, "h-7 font-mono")}
                    dir="ltr"
                    placeholder={t("uiStep.jsonTemplateHint")}
                    aria-label={t("uiStep.jsonTemplate")}
                    value={item.jsonTemplate ?? ""}
                    onChange={(event) => patchSeed(index, { jsonTemplate: event.target.value || undefined })}
                  />
                </div>
              );
            })}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStorage([...storage, { area: "localStorage", key: "" }]);
                setDirty(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("uiStep.storageAdd")}
            </Button>
          </div>
        </div>
      </details>

      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t("uiStep.options")}</summary>
        <div className="space-y-2 px-3 pb-3">
          <label className="block max-w-48 space-y-1">
            <span className="text-[11px] text-muted-foreground">{t("uiStep.timeout")}</span>
            <input
              className={cn(input, "font-mono")}
              dir="ltr"
              inputMode="numeric"
              value={timeout}
              onChange={(event) => {
                setTimeoutValue(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={failOnPageError}
              onChange={(event) => {
                setFailOnPageError(event.target.checked);
                setDirty(true);
              }}
            />
            <span>
              {t("uiStep.failOnPageError")}
              <span className="block text-[11px] text-muted-foreground">{t("uiStep.failOnPageErrorHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={newSession}
              onChange={(event) => {
                setNewSession(event.target.checked);
                setDirty(true);
              }}
            />
            <span>
              {t("uiStep.newSession")}
              <span className="block text-[11px] text-muted-foreground">{t("uiStep.newSessionHint")}</span>
            </span>
          </label>
        </div>
      </details>

      <p className="text-[11px] text-muted-foreground">{t("uiStep.variablesHint")}</p>

      <div className="flex justify-end">
        <Button size="sm" disabled={!dirty || busy || !startUrl.trim()} onClick={() => void save()}>
          {t("builder.settings.save")}
        </Button>
      </div>
    </div>
  );
}

function IconButton({ label, disabled, danger, onClick, children }: { label: string; disabled?: boolean; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40",
        danger && "hover:text-destructive",
      )}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The Result tab of a UI step: every action, how its element was found, the final page. */
export function UiResultTab({ output, error }: { output: UiOutput | null; error?: string | null }) {
  const { t, n, err } = useI18n();
  if (!output || output.kind !== "ui") {
    return <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("builder.panel.runToSee")}</p>;
  }
  const actions = output.actions ?? [];
  const healed = actions.filter((action) => action.healed).length;
  return (
    <div className="space-y-4">
      {output.url ? (
        <p className="text-xs">
          <span className="text-muted-foreground">{t("uiStep.finalPage")}: </span>
          <span className="font-mono break-all" dir="ltr">
            {output.url}
          </span>
          {output.title ? <span className="text-muted-foreground"> · {output.title}</span> : null}
        </p>
      ) : null}
      {output.signedIn ? (
        <div className="rounded-md border border-border px-2 py-1.5 text-[11px]">
          <p className="mb-0.5 font-medium">{t("uiStep.signedInTitle")}</p>
          <SignedInSummary signedIn={output.signedIn} />
        </div>
      ) : null}
      {healed > 0 ? (
        <p className="flex items-start gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-[11px]">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          {t("uiStep.learnedNote", { count: n(healed) })}
        </p>
      ) : null}
      {output.pageErrors?.length ? (
        <div className="rounded-md border border-warning/50 bg-warning/5 px-2 py-1.5 text-[11px]">
          <p className="font-medium text-warning">{t("uiStep.pageErrors")}</p>
          <ul className="mt-0.5 space-y-0.5">
            {output.pageErrors.map((item) => (
              <li key={item}>
                <BidiText text={item} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error && !actions.some((action) => action.status === "FAILED") ? <p className="text-xs text-destructive">{err(error)}</p> : null}

      <ol className="space-y-1" aria-label={t("uiStep.actions")}>
        {actions.map((action, index) => (
          <li key={action.id} className="space-y-0.5 rounded-md border border-border px-2 py-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-end font-mono text-[10px] text-muted-foreground">{n(index + 1)}</span>
              {action.status === "PASSED" ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-label={t("status.PASSED")} />
              ) : action.status === "FAILED" ? (
                action.optional ? (
                  <MinusCircle className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={t("uiStep.optionalFailed")} />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t("status.FAILED")} />
                )
              ) : (
                <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("status.SKIPPED")} />
              )}
              <BidiText text={action.label} className="min-w-0 flex-1 truncate" />
              {action.healed ? (
                <span className="shrink-0 rounded border border-primary/40 px-1 text-[10px] text-primary" title={t("uiStep.healedHint")}>
                  {t("uiStep.healed")}
                </span>
              ) : null}
              <span className="shrink-0 text-[10px] text-muted-foreground">{t("builder.flow.ms", { value: n(action.durationMs) })}</span>
            </div>
            {action.how ? (
              <p className="truncate ps-7 font-mono text-[10px] text-muted-foreground" dir="ltr" title={action.how}>
                {action.how}
              </p>
            ) : null}
            {action.error ? <p className="ps-7 text-[11px] text-destructive">{err(action.error)}</p> : null}
          </li>
        ))}
      </ol>

      {output.screenshot ? (
        <figure className="space-y-1">
          <figcaption className="text-[11px] text-muted-foreground">{t("uiStep.screenshot")}</figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the run, not an optimizable asset */}
          <img src={output.screenshot} alt={t("uiStep.screenshotAlt")} className="w-full rounded-md border border-border" />
        </figure>
      ) : null}

      {output.values?.length ? (
        <section className="space-y-1">
          <h3 className="text-xs font-medium">{t("uiStep.produced")}</h3>
          <p className="text-[11px] text-muted-foreground">{t("uiStep.producedHint")}</p>
          <ul className="max-h-48 space-y-0.5 overflow-auto">
            {output.values.slice(0, 40).map((value) => (
              <li key={value.path} className="flex gap-2 font-mono text-[10px]" dir="ltr">
                <span className="text-muted-foreground">{value.path.replace(/^response\.body\./, "")}</span>
                <span className="truncate">{value.display}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
