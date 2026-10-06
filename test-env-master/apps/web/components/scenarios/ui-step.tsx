"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  RotateCcw,
  Circle,
  Eye,
  Globe,
  Hand,
  Hourglass,
  Keyboard,
  ListChecks,
  Loader2,
  MinusCircle,
  MousePointerClick,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Type,
  Upload,
  Video,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BidiText } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { Step, StepOutput, UiLiveProgress } from "@/components/scenarios/builder-types";
import { SaveSessionPanel, SessionPicker, type SessionChoice } from "@/components/scenarios/saved-sessions";

/** Mirrors the API's UI action (apps/api/src/scenario-engine/ui/ui-types.ts). */
export type UiAction = {
  id: string;
  kind: "navigate" | "click" | "fill" | "select" | "check" | "uncheck" | "press" | "hover" | "upload" | "waitForElement" | "waitForText" | "assertText" | "assertUrl";
  target?: {
    candidates: Array<{ kind: string; value: string; name?: string; unique?: boolean; confidence?: number }>;
    fingerprint: Record<string, unknown>;
    learned?: number;
    /** The element is in a table / list row, found by what identifies the row. */
    scope?: {
      container?: { role?: string; name?: string };
      identity: Array<{ strategy: string; attr?: string; value?: string; column?: string; columnIndex?: number; index?: number }>;
      target: Array<{ kind: string; value: string; name?: string; confidence?: number }>;
      rowCount?: number;
    };
    context?: { role?: string; name?: string };
  };
  files?: Array<{ name: string; type?: string }>;
  dynamicValue?: "uuid" | "timestamp" | "random";
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
  code?: string;
  diagnostics?: Record<string, unknown>;
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
  /** "preparing": the step's earlier actions are replayed before recording starts. */
  state: "preparing" | "recording" | "stopped";
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
    case "hover":
      return Hand;
    case "upload":
      return Upload;
    case "waitForElement":
      return Hourglass;
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
 * step it was started from (added to the end, or replacing its actions). With
 * `fromActionId`, only a part of the step is re-recorded: the actions before it
 * are replayed first, and the recording replaces the chosen actions.
 */
export function UiRecordDialog({
  scenarioId,
  step,
  fromActionId,
  initialMode,
  earlierSteps,
  steps,
  onClose,
  onSaved,
}: {
  scenarioId: string;
  step?: Step | null;
  /** Re-record the step's actions from this one (up to one chosen in the dialog). */
  fromActionId?: string;
  /** How the recording goes into the step it was started from. */
  initialMode?: "append" | "replace" | "part";
  /** Steps that run before this one (they can sign the browser in). */
  earlierSteps: number;
  /** All steps of the precondition, for choosing which supply the session. */
  steps: Step[];
  onClose: () => void;
  onSaved: (step: Step) => void | Promise<void>;
}) {
  const { t, n, err } = useI18n();
  const existing = step ? uiActions(step.config) : [];
  const lastUrl = [...existing].reverse().find((action) => action.url)?.url;
  const [name, setName] = useState("");
  const [startUrl, setStartUrl] = useState(String(step?.config.startUrl ?? ""));
  const [mode, setMode] = useState<"append" | "replace" | "part">(fromActionId ? "part" : (initialMode ?? "append"));
  const [fromId, setFromId] = useState(fromActionId ?? existing[0]?.id ?? "");
  const [toActionId, setToActionId] = useState(fromActionId ?? existing[0]?.id ?? "");
  const fromIndex = Math.max(0, existing.findIndex((action) => action.id === fromId));
  const toIndex = Math.max(fromIndex, existing.findIndex((action) => action.id === toActionId));
  const partial = mode === "part" && existing.length > 0;
  const [signedIn, setSignedIn] = useState(true);
  const sources = sessionSources(steps, step ? step.orderIndex : null);
  const savedFrom = ((step?.config.session ?? {}) as { fromSteps?: string[] }).fromSteps;
  const [fromSteps, setFromSteps] = useState<string[] | null>(savedFrom?.length ? savedFrom : null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const recordingId = recording?.id;
  const active = recording?.state === "recording";
  const open = Boolean(recording && recording.state !== "stopped");

  // Live list while recording; stops by itself when the browser is closed or the badge's stop is pressed.
  useEffect(() => {
    if (!recordingId || !open) return;
    const timer = setInterval(() => {
      void api<Recording>(`/scenarios/ui-recordings/${recordingId}`)
        .then(setRecording)
        .catch(() => undefined);
    }, 800);
    return () => clearInterval(timer);
  }, [recordingId, open]);

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
          body: JSON.stringify({
            startUrl: url,
            signedIn: earlierSteps > 0 && signedIn,
            fromSteps,
            ...(step ? { stepId: step.id } : {}),
            ...(partial ? { fromActionId: existing[fromIndex]!.id, toActionId: existing[toIndex]!.id } : {}),
          }),
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
      title={partial ? t("uiStep.rerecordTitle") : step ? t("uiStep.recordMoreTitle") : t("uiStep.recordTitle")}
      description={partial ? t("uiStep.rerecordHint") : t("uiStep.recordHint")}
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
          ) : open ? (
            <Button variant="destructive" disabled={busy} onClick={() => void stop()}>
              <Square className="h-3.5 w-3.5" />
              {t("uiStep.stop")}
            </Button>
          ) : (
            <Button disabled={busy || count === 0} onClick={() => void save()}>
              {partial ? t("uiStep.rerecordSave", { count: n(toIndex - fromIndex + 1) }) : step ? t("uiStep.saveInto") : t("uiStep.save", { count: n(count) })}
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
            {step && !partial && lastUrl && lastUrl !== startUrl ? (
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
              <>
                <fieldset className="flex flex-wrap gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={mode === "append"} onChange={() => setMode("append")} />
                    {t("uiStep.append", { count: n(existing.length) })}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />
                    {t("uiStep.replace")}
                  </label>
                  {existing.length > 0 ? (
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={mode === "part"} onChange={() => setMode("part")} />
                      {t("uiStep.replacePart")}
                    </label>
                  ) : null}
                </fieldset>
                {partial ? (
              <div className="space-y-1.5 rounded-md border border-border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>{t("uiStep.rerecordFromLabel")}</span>
                  <select
                    className={cn(input, "h-7 w-auto max-w-60")}
                    aria-label={t("uiStep.rerecordFromLabel")}
                    value={existing[fromIndex]!.id}
                    onChange={(event) => {
                      setFromId(event.target.value);
                      if (toIndex < existing.findIndex((action) => action.id === event.target.value)) setToActionId(event.target.value);
                    }}
                  >
                    {existing.map((action, index) => (
                      <option key={action.id} value={action.id}>
                        {n(index + 1)} · {action.label ?? t(`uiStep.kinds.${action.kind}`)}
                      </option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">{t("uiStep.rerecordTo")}</span>
                  <select className={cn(input, "h-7 w-auto max-w-60")} aria-label={t("uiStep.rerecordTo")} value={existing[toIndex]!.id} onChange={(event) => setToActionId(event.target.value)}>
                    {existing.slice(fromIndex).map((action, offset) => (
                      <option key={action.id} value={action.id}>
                        {n(fromIndex + offset + 1)} · {action.label ?? t(`uiStep.kinds.${action.kind}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <ol className="max-h-32 space-y-0.5 overflow-auto ps-1 text-[11px]">
                  {existing.slice(fromIndex, toIndex + 1).map((action, offset) => (
                    <li key={action.id} className="flex gap-1.5 text-muted-foreground line-through">
                      <span className="font-mono">{n(fromIndex + offset + 1)}</span>
                      <BidiText text={action.label ?? ""} className="min-w-0 truncate" />
                    </li>
                  ))}
                </ol>
                {fromIndex > 0 ? <p className="text-[11px] text-muted-foreground">{t("uiStep.rerecordReplays", { count: n(fromIndex) })}</p> : null}
              </div>
                ) : null}
              </>
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
            {earlierSteps > 0 && signedIn && sources.length > 1 ? (
              <SourceChooser sources={sources} steps={steps} value={fromSteps} onChange={setFromSteps} />
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
              {open ? <span className={cn("h-2 w-2 animate-pulse rounded-full", active ? "bg-destructive" : "bg-primary")} aria-hidden /> : null}
              {active ? t("uiStep.recording") : open ? t("uiStep.preparing") : t("uiStep.stopped", { count: n(count) })}
            </p>
            {recording.error ? <p className="text-xs text-warning">{err(recording.error)}</p> : null}
            {recording.prepared ? <PreparedNote prepared={recording.prepared} /> : null}
            <SaveSessionPanel recordingId={recording.id} />
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

/** Earlier steps that can supply the session: HTTP calls (e.g. imported cURL) and UI steps. */
export const sessionSources = (steps: Step[], before: number | null) =>
  steps.filter((item) => (item.type === "HTTP_REQUEST" || item.type === "UI_FLOW") && (before === null || item.orderIndex < before));

/** Choose which earlier steps the browser takes cookies, headers and the token from. */
function SourceChooser({ sources, steps, value, onChange }: { sources: Step[]; steps: Step[]; value: string[] | null; onChange: (next: string[] | null) => void }) {
  const { t, n } = useI18n();
  const number = (step: Step) => steps.findIndex((item) => item.id === step.id) + 1;
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs">{t("uiStep.sourcesTitle")}</legend>
      <label className="flex items-center gap-1.5 text-xs">
        <input type="radio" checked={value === null} onChange={() => onChange(null)} />
        {t("uiStep.sourcesAll")}
      </label>
      <label className="flex items-center gap-1.5 text-xs">
        <input type="radio" checked={value !== null} onChange={() => onChange(sources.slice(-1).map((item) => item.id))} />
        {t("uiStep.sourcesOnly")}
      </label>
      {value !== null ? (
        <ul className="max-h-44 space-y-0.5 overflow-auto ps-5">
          {sources.map((item) => {
            const method = typeof item.config.method === "string" ? item.config.method.toUpperCase() : "";
            const where = String(item.type === "UI_FLOW" ? (item.config.startUrl ?? "") : (item.config.url ?? ""));
            return (
              <li key={item.id}>
                <label className="flex min-w-0 items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={value.includes(item.id)}
                    onChange={(event) => onChange(event.target.checked ? [...value, item.id] : value.filter((id) => id !== item.id))}
                  />
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{n(number(item))}</span>
                  <span className="shrink-0 font-mono text-[10px] font-semibold text-primary">{item.type === "UI_FLOW" ? "UI" : method}</span>
                  <span className="min-w-0 truncate">{item.name}</span>
                  <span className="hidden min-w-0 truncate font-mono text-[10px] text-muted-foreground sm:inline" dir="ltr">
                    {where}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {value !== null && value.length === 0 ? <p className="ps-5 text-[11px] text-warning">{t("uiStep.sourcesNone")}</p> : null}
    </fieldset>
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
  steps,
  earlierValues,
  onSave,
  onRecordMore,
  onRerecord,
}: {
  step: Step;
  steps: Step[];
  /** Values earlier steps produced in the last run, to put into page storage. */
  earlierValues: EarlierValue[];
  onSave: (config: Record<string, unknown>) => Promise<void>;
  onRecordMore: () => void;
  /** Re-record the saved step's actions from this one (its page changed). */
  onRerecord: (actionId: string) => void;
}) {
  const { t, n } = useI18n();
  const [startUrl, setStartUrl] = useState(String(step.config.startUrl ?? ""));
  const [actions, setActions] = useState<UiAction[]>(uiActions(step.config));
  const [timeout, setTimeoutValue] = useState(String(step.config.actionTimeoutMs ?? 15000));
  const [newSession, setNewSession] = useState(step.config.newSession === true);
  const [failOnPageError, setFailOnPageError] = useState(step.config.failOnPageError !== false);
  const savedSession = (step.config.session ?? {}) as { fromEarlierSteps?: boolean; fromSteps?: string[]; storage?: StorageSeed[] } & SessionChoice;
  const [sessionChoice, setSessionChoice] = useState<SessionChoice>({
    useSavedSession: savedSession.useSavedSession,
    savedSessionId: savedSession.savedSessionId,
    signedInText: savedSession.signedInText,
  });
  const [fromEarlier, setFromEarlier] = useState(savedSession.fromEarlierSteps !== false);
  const [storage, setStorage] = useState<StorageSeed[]>(savedSession.storage ?? []);
  const [fromSteps, setFromSteps] = useState<string[] | null>(savedSession.fromSteps?.length ? savedSession.fromSteps : null);
  const sources = sessionSources(steps, step.orderIndex);
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
          fromEarlier && storage.length === 0 && !fromSteps && !sessionChoice.savedSessionId && !sessionChoice.useSavedSession
            ? undefined
            : {
                ...(fromEarlier ? {} : { fromEarlierSteps: false }),
                ...(fromSteps ? { fromSteps } : {}),
                ...(storage.length ? { storage: storage.filter((item) => item.key.trim()) } : {}),
                ...(sessionChoice.savedSessionId ? { savedSessionId: sessionChoice.savedSessionId } : {}),
                ...(sessionChoice.useSavedSession ? { useSavedSession: true } : {}),
                ...(sessionChoice.signedInText ? { signedInText: sessionChoice.signedInText } : {}),
              },
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
                    <IconButton label={t("uiStep.rerecordFrom")} disabled={dirty} onClick={() => onRerecord(action.id)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </IconButton>
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
                  {locator ? <LocatorBadge target={action.target!} locator={locator} /> : null}
                  {action.dynamicValue ? <span className="text-[10px] text-warning">{t("uiStep.dynamicValue", { kind: action.dynamicValue })}</span> : null}
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

      <SessionPicker
        value={sessionChoice}
        onChange={(next) => {
          setSessionChoice(next);
          setDirty(true);
        }}
      />

      <details className="rounded-md border border-border" open={storage.length > 0 || !fromEarlier || fromSteps !== null}>
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
          {sources.length > 0 ? (
            <SourceChooser
              sources={sources}
              steps={steps}
              value={fromSteps}
              onChange={(next) => {
                setFromSteps(next);
                setDirty(true);
              }}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">{t("uiStep.sourcesEmpty")}</p>
          )}
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
            {action.error ? (
              <p className="ps-7 text-[11px] text-destructive">
                {action.code ? <span className="me-1 font-mono">[{action.code}]</span> : null}
                {err(action.error)}
              </p>
            ) : null}
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

/**
 * How the action finds its element: the row it is in (by what identifies the
 * row) and the way inside it, or the main locator — with its confidence.
 */
function LocatorBadge({ target, locator }: { target: NonNullable<UiAction["target"]>; locator: NonNullable<UiAction["target"]>["candidates"][number] }) {
  const { t, n } = useI18n();
  const show = (item: { kind: string; value: string; name?: string }) => (item.kind === "role" ? `${item.value} "${item.name ?? ""}"` : item.value);
  const all = target.candidates.map((item) => `${item.kind}: ${show(item)}${item.confidence !== undefined ? ` (${Math.round(item.confidence * 100)}%)` : ""}`).join("\n");
  if (target.scope) {
    const identity = target.scope.identity
      .map((item) => (item.strategy === "index" ? `#${n((item.index ?? 0) + 1)}` : item.strategy === "cell" ? `${item.column ?? n((item.columnIndex ?? 0) + 1)}=${item.value}` : item.strategy === "attr" ? `${item.attr}=${item.value}` : item.value))
      .join(" + ");
    const inner = target.scope.target[0];
    return (
      <span className="min-w-0 truncate text-[10px] text-muted-foreground" title={all}>
        {t("uiStep.inRow", { container: target.scope.container?.name ?? t("uiStep.list"), row: identity })}
        {inner ? <span className="font-mono" dir="ltr"> → {show(inner)}</span> : null}
        {inner?.confidence !== undefined ? ` · ${n(Math.round(inner.confidence * 100))}%` : ""}
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" dir="ltr" title={all}>
      {show(locator)}
      {locator.confidence !== undefined ? ` · ${Math.round(locator.confidence * 100)}%` : ""}
      {target.candidates.length > 1 ? ` +${n(target.candidates.length - 1)}` : ""}
    </span>
  );
}

function LiveIcon({ status }: { status: UiLiveProgress["actions"][number]["status"] }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  if (status === "passed") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  if (status === "skipped") return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />;
}

/**
 * A UI step while it runs: what it is doing (opening the browser, signing in,
 * loading the start page, or action n of N) and every action with its state —
 * like the analysis runner's stage list. `compact`: one line for the flow list.
 */
export function UiLiveProgressView({ progress, compact = false }: { progress: UiLiveProgress; compact?: boolean }) {
  const { t, n } = useI18n();
  const listRef = useRef<HTMLOListElement | null>(null);
  const running = progress.actions.find((item) => item.status === "running");
  const done = progress.actions.filter((item) => item.status === "passed" || item.status === "failed" || item.status === "skipped").length;
  const headline =
    progress.phase === "actions" && running
      ? t("uiStep.live.action", { current: n(progress.current), total: n(progress.total) })
      : t(`uiStep.live.${progress.phase}`);

  useEffect(() => {
    listRef.current?.querySelector('[data-live="running"]')?.scrollIntoView({ block: "nearest" });
  }, [progress.current]);

  if (compact) {
    return (
      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-primary" role="status">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        <span className="shrink-0">{headline}</span>
        {running ? <BidiText text={`· ${running.label}`} className="min-w-0 truncate text-muted-foreground" /> : null}
      </span>
    );
  }
  return (
    <section className="space-y-2" aria-live="polite" aria-label={t("uiStep.live.title")}>
      <div className="flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        <span className="font-medium">{headline}</span>
        <span className="ms-auto text-[11px] text-muted-foreground">{t("uiStep.live.done", { done: n(done), total: n(progress.total) })}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.total ? Math.round((100 * done) / progress.total) : 0}%` }} />
      </div>
      <ol ref={listRef} className="max-h-60 space-y-0.5 overflow-auto">
        {progress.actions.map((item, index) => (
          <li
            key={item.id}
            data-live={item.status}
            className={cn("flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs", item.status === "running" && "bg-primary/5", item.status === "pending" && "text-muted-foreground")}
          >
            <span className="w-5 shrink-0 text-end font-mono text-[10px] text-muted-foreground">{n(index + 1)}</span>
            <LiveIcon status={item.status} />
            <BidiText text={item.label} className="min-w-0 flex-1 truncate" />
          </li>
        ))}
      </ol>
    </section>
  );
}
