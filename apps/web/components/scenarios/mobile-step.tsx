"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Circle,
  Eye,
  Hand,
  Hourglass,
  Loader2,
  Eraser,
  MousePointerClick,
  RefreshCw,
  Smartphone,
  Square,
  Trash2,
  Type,
  Undo2,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BidiText } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress";
import type { Step } from "@/components/scenarios/builder-types";

/** Mirrors the API's mobile locator (apps/api/src/scenario-engine/mobile/mobile-locators.ts). */
export type MobileLocator = { using: string; value: string; score?: number; unique?: boolean; matches?: number; reasons?: string[] };

export type MobileActionKind = "tap" | "type" | "clear" | "longPress" | "swipe" | "back" | "assertText" | "assertVisible" | "waitForElement";

/** Mirrors the API's mobile action (apps/api/src/scenario-engine/mobile/mobile-types.ts). */
export type MobileAction = {
  id: string;
  kind: MobileActionKind;
  target?: { candidates: MobileLocator[]; fingerprint: { tag: string; name?: string; text?: string; resourceId?: string; accessibilityId?: string }; learned?: number };
  value?: string;
  secret?: boolean;
  direction?: "up" | "down" | "left" | "right";
  label?: string;
  optional?: boolean;
};

type Stage = { id: string; status: "pending" | "running" | "done" | "failed"; detail?: string };

type Recording = {
  id: string;
  platform: "android" | "ios";
  serverUrl: string;
  state: "connecting" | "ready" | "working" | "stopped" | "failed";
  operation: "connect" | "capture" | "action" | null;
  stages: Stage[];
  error: string | null;
  lastAction: { label: string; how: string; fallback: boolean } | null;
  screenVersion: number;
  actions: Array<{ id: string; kind: MobileActionKind; label: string; secret?: boolean }>;
};

type ScreenElement = {
  id: string;
  tag: string;
  name: string;
  interactive: boolean;
  editable: boolean;
  password: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  attributes: Record<string, string>;
  locators: MobileLocator[];
};

type Screen = { version: number; screenshot: string | null; width: number; height: number; elements: ScreenElement[]; capturedAt: string };

const DEFAULT_SERVER = "http://127.0.0.1:4723";
const CAPABILITY_EXAMPLES: Record<"android" | "ios", Record<string, unknown>> = {
  android: { "appium:deviceName": "Android Emulator", "appium:appPackage": "com.example.app", "appium:appActivity": ".MainActivity", "appium:noReset": true },
  ios: { "appium:deviceName": "iPhone 15", "appium:platformVersion": "17.5", "appium:bundleId": "com.example.app", "appium:noReset": true },
};
const POLL_MS = 700;
const input = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";
const ELEMENT_ACTIONS: MobileActionKind[] = ["tap", "type", "clear", "longPress", "assertText", "assertVisible", "waitForElement"];

export function mobileActionIcon(kind: MobileActionKind) {
  switch (kind) {
    case "tap":
      return MousePointerClick;
    case "type":
      return Type;
    case "clear":
      return Eraser;
    case "longPress":
      return Hand;
    case "swipe":
      return ArrowUp;
    case "back":
      return Undo2;
    case "waitForElement":
      return Hourglass;
    default:
      return Eye;
  }
}

export function mobileActions(config: Record<string, unknown>): MobileAction[] {
  return Array.isArray(config.actions) ? (config.actions as MobileAction[]) : [];
}

/**
 * Record a mobile step through Appium, like an inspector: the device's
 * screen is shown here with the elements Appium reports; choose one, then an
 * action. The action runs on the device and is recorded only when it worked;
 * the screen is read again after it. Every operation shows its stages.
 */
export function MobileRecordDialog({
  scenarioId,
  step,
  onClose,
  onSaved,
}: {
  scenarioId: string;
  /** Record into this mobile step (append or replace) instead of creating one. */
  step?: Step | null;
  onClose: () => void;
  onSaved: (step: Step) => void | Promise<void>;
}) {
  const { t, n, err } = useI18n();
  const existing = step ? mobileActions(step.config) : [];
  const savedPlatform = step?.config.platform === "ios" ? "ios" : "android";
  const [platform, setPlatform] = useState<"android" | "ios">(savedPlatform);
  const [serverUrl, setServerUrl] = useState(String(step?.config.serverUrl ?? DEFAULT_SERVER));
  const [capabilities, setCapabilities] = useState(JSON.stringify(step?.config.capabilities ?? CAPABILITY_EXAMPLES[savedPlatform], null, 2));
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [locatorIndex, setLocatorIndex] = useState(0);
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);
  const [filter, setFilter] = useState("");
  const [showText, setShowText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recordingId = recording?.id;
  const working = recording?.state === "connecting" || recording?.state === "working";
  const open = Boolean(recording && recording.state !== "stopped" && recording.state !== "failed");
  const screenVersion = recording?.screenVersion ?? 0;

  let parsedCapabilities: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(capabilities) as unknown;
    parsedCapabilities = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    parsedCapabilities = null;
  }

  // Follow the running operation (connect, action, screen read) stage by stage.
  useEffect(() => {
    if (!recordingId || !working) return;
    const timer = setInterval(() => {
      void api<Recording>(`/scenarios/mobile-recordings/${recordingId}`)
        .then(setRecording)
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [recordingId, working]);

  // A new screen was read: show it (the previous element choice belonged to the old screen).
  useEffect(() => {
    if (!recordingId || !screenVersion) return;
    let alive = true;
    void api<Screen>(`/scenarios/mobile-recordings/${recordingId}/screen`)
      .then((next) => {
        if (!alive) return;
        setScreen(next);
        setSelectedId(null);
        setLocatorIndex(0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [recordingId, screenVersion]);

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
      if (!parsedCapabilities) throw new Error("Capabilities must be a JSON object");
      setRecording(
        await api<Recording>(`/scenarios/${scenarioId}/mobile-recordings`, {
          method: "POST",
          body: JSON.stringify({ platform, serverUrl: serverUrl.trim(), capabilities: parsedCapabilities, ...(step ? { stepId: step.id } : {}) }),
        }),
      );
    });

  const act = (kind: MobileActionKind, extra: Record<string, unknown> = {}) =>
    work(async () => {
      setRecording(
        await api<Recording>(`/scenarios/mobile-recordings/${recording!.id}/actions`, {
          method: "POST",
          body: JSON.stringify({ kind, ...extra }),
        }),
      );
      if (kind === "type" || kind === "assertText") setValue("");
    });

  const refresh = () => work(async () => setRecording(await api<Recording>(`/scenarios/mobile-recordings/${recording!.id}/refresh`, { method: "POST", body: "{}" })));
  const stop = () => work(async () => setRecording(await api<Recording>(`/scenarios/mobile-recordings/${recording!.id}/stop`, { method: "POST", body: "{}" })));
  const remove = (actionId: string) =>
    work(async () => setRecording(await api<Recording>(`/scenarios/mobile-recordings/${recording!.id}/actions/${actionId}/remove`, { method: "POST", body: "{}" })));
  const save = () =>
    work(async () => {
      const saved = await api<Step>(`/scenarios/mobile-recordings/${recording!.id}/save`, { method: "POST", body: JSON.stringify({ name: name.trim() || undefined, mode }) });
      await onSaved(saved);
      onClose();
    });
  const close = () => {
    if (recording) void api(`/scenarios/mobile-recordings/${recording.id}/discard`, { method: "POST", body: "{}" }).catch(() => undefined);
    onClose();
  };

  const selected = screen?.elements.find((element) => element.id === selectedId) ?? null;
  const count = recording?.actions.length ?? 0;
  const canAct = recording?.state === "ready" && !busy;

  return (
    <Dialog
      open
      title={step ? t("mobileStep.recordMoreTitle") : t("mobileStep.recordTitle")}
      description={t("mobileStep.recordHint")}
      closeLabel={t("builder.panel.close")}
      onClose={close}
      className="max-w-6xl"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {recording ? t("uiStep.discard") : t("common.cancel")}
          </Button>
          {!recording ? (
            <Button disabled={busy || !serverUrl.trim() || !parsedCapabilities} onClick={() => void start()}>
              <Smartphone className="h-3.5 w-3.5" />
              {t("mobileStep.connect")}
            </Button>
          ) : open ? (
            <Button variant="destructive" disabled={busy || recording.state === "connecting"} onClick={() => void stop()}>
              <Square className="h-3.5 w-3.5" />
              {t("mobileStep.stop")}
            </Button>
          ) : (
            <Button disabled={busy || count === 0} onClick={() => void save()}>
              {step ? t("uiStep.saveInto") : t("uiStep.save", { count: n(count) })}
            </Button>
          )}
        </>
      }
    >
      {!recording ? (
        <div className="space-y-3">
          <fieldset className="flex flex-wrap items-center gap-3 text-xs">
            <legend className="sr-only">{t("mobileStep.platform")}</legend>
            <span className="text-muted-foreground">{t("mobileStep.platform")}</span>
            {(["android", "ios"] as const).map((item) => (
              <label key={item} className="flex items-center gap-1.5">
                <input type="radio" checked={platform === item} onChange={() => setPlatform(item)} />
                {t(`mobileStep.${item}`)}
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("mobileStep.serverUrl")}</span>
            <input className={cn(input, "font-mono")} dir="ltr" value={serverUrl} placeholder={DEFAULT_SERVER} onChange={(event) => setServerUrl(event.target.value)} />
            <span className="block text-[11px] text-muted-foreground">{t("mobileStep.serverHint")}</span>
          </label>
          <label className="block space-y-1 text-xs">
            <span className="flex items-center gap-2 text-muted-foreground">
              {t("mobileStep.capabilities")}
              <button type="button" className="ms-auto text-[11px] text-primary hover:underline" onClick={() => setCapabilities(JSON.stringify(CAPABILITY_EXAMPLES[platform], null, 2))}>
                {t("mobileStep.resetCapabilities", { platform: t(`mobileStep.${platform}`) })}
              </button>
            </span>
            <textarea
              className="min-h-36 w-full rounded-md border border-border bg-background p-2 font-mono text-[11px]"
              dir="ltr"
              spellCheck={false}
              value={capabilities}
              aria-invalid={!parsedCapabilities}
              onChange={(event) => setCapabilities(event.target.value)}
            />
            <span className={cn("block text-[11px]", parsedCapabilities ? "text-muted-foreground" : "text-destructive")}>
              {parsedCapabilities ? t("mobileStep.capabilitiesHint") : t("mobileStep.capabilitiesInvalid")}
            </span>
          </label>
          {!step ? (
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("builder.settings.name")}</span>
              <input className={input} value={name} placeholder={t("mobileStep.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
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
        </div>
      ) : (
        <div className="space-y-3">
          <p
            className={cn("flex items-center gap-2 text-xs", recording.state === "failed" ? "text-destructive" : recording.state === "ready" ? "text-success" : "text-muted-foreground")}
            role="status"
          >
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden /> : null}
            {recording.state === "stopped" ? t("mobileStep.state.stopped", { count: n(count) }) : t(`mobileStep.state.${recording.state}`)}
          </p>
          {recording.stages.length ? <StageList stages={recording.stages} /> : null}
          {recording.error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {err(recording.error)}
            </p>
          ) : null}
          {recording.lastAction?.how && !recording.error ? (
            <p className={cn("text-[11px]", recording.lastAction.fallback ? "text-warning" : "text-muted-foreground")}>
              <BidiText text={recording.lastAction.label} />
              {" · "}
              {t(recording.lastAction.fallback ? "mobileStep.lastFallback" : "mobileStep.lastAction", { how: recording.lastAction.how })}
            </p>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <section className="space-y-2" aria-label={t("mobileStep.screen")}>
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium">{t("mobileStep.screen")}</h3>
                <Button size="sm" variant="ghost" className="ms-auto" disabled={!canAct} onClick={() => void refresh()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("mobileStep.refresh")}
                </Button>
              </div>
              {screen ? (
                <ScreenView screen={screen} selectedId={selectedId} showText={showText} onSelect={(id) => (setSelectedId(id), setLocatorIndex(0))} />
              ) : (
                <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
                  {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : t("mobileStep.noScreenshot")}
                </div>
              )}
              {screen && !screen.screenshot ? <p className="text-[11px] text-muted-foreground">{t("mobileStep.noScreenshot")}</p> : null}
              <div className="flex flex-wrap gap-1">
                <span className="w-full text-[11px] text-muted-foreground">{t("mobileStep.screenActions")}</span>
                {(["up", "down", "left", "right"] as const).map((direction) => {
                  const Icon = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight }[direction];
                  return (
                    <Button key={direction} size="sm" variant="outline" disabled={!canAct} title={t(`mobileStep.swipe.${direction}`)} onClick={() => void act("swipe", { direction })}>
                      <Icon className="h-3.5 w-3.5" />
                      <span className="sr-only">{t(`mobileStep.swipe.${direction}`)}</span>
                    </Button>
                  );
                })}
                {recording.platform === "android" ? (
                  <Button size="sm" variant="outline" disabled={!canAct} onClick={() => void act("back")}>
                    <Undo2 className="h-3.5 w-3.5" />
                    {t("mobileStep.actions.back")}
                  </Button>
                ) : null}
              </div>
            </section>

            <div className="min-w-0 space-y-3">
              {selected ? (
                <ElementInspector
                  element={selected}
                  locatorIndex={locatorIndex}
                  onLocator={setLocatorIndex}
                  value={value}
                  onValue={setValue}
                  secret={secret || selected.password}
                  onSecret={setSecret}
                  disabled={!canAct}
                  onAct={(kind) =>
                    void act(kind, {
                      elementId: selected.id,
                      locatorIndex,
                      ...(kind === "type" || kind === "assertText" ? { value } : {}),
                      ...(kind === "type" && (secret || selected.password) ? { secret: true } : {}),
                    })
                  }
                />
              ) : (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t("mobileStep.selectElement")}</p>
              )}
              {screen ? (
                <ElementList
                  elements={screen.elements}
                  selectedId={selectedId}
                  filter={filter}
                  onFilter={setFilter}
                  showText={showText}
                  onShowText={setShowText}
                  onSelect={(id) => (setSelectedId(id), setLocatorIndex(0))}
                />
              ) : null}
              <section className="space-y-1" aria-label={t("mobileStep.recorded")}>
                <h3 className="text-xs font-medium">{t("mobileStep.recorded")}</h3>
                {count === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">{t("mobileStep.waiting")}</p>
                ) : (
                  <ol className="max-h-48 space-y-1 overflow-auto">
                    {recording.actions.map((action, index) => {
                      const Icon = mobileActionIcon(action.kind);
                      return (
                        <li key={action.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                          <span className="w-5 shrink-0 text-end font-mono text-[10px] text-muted-foreground">{n(index + 1)}</span>
                          <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                          <BidiText text={action.label} className="min-w-0 flex-1 truncate" />
                          <IconButton label={t("mobileStep.removeAction")} danger disabled={busy || working} onClick={() => void remove(action.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </IconButton>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
              {!open && !step ? (
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("builder.settings.name")}</span>
                  <input className={input} value={name} placeholder={t("mobileStep.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
                </label>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {err(error)}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The stages of the running (or last) operation, with a progress bar, like a run's live view. */
export function StageList({ stages }: { stages: Stage[] }) {
  const { t, n } = useI18n();
  const done = stages.filter((stage) => stage.status === "done").length;
  const running = stages.find((stage) => stage.status === "running");
  const detail = (stage: Stage) => {
    if (!stage.detail) return "";
    if (stage.id === "detect") return t("mobileStep.stageDetail.elements", { count: n(Number(stage.detail)) });
    if (stage.id === "rank") return t("mobileStep.stageDetail.locators", { count: n(Number(stage.detail)) });
    return t(`mobileStep.stageDetail.${stage.detail}`);
  };
  return (
    <section className="space-y-1.5 rounded-md border border-border p-2" aria-live="polite" aria-label={t("mobileStep.stagesTitle")}>
      <ProgressBar size="sm" value={(100 * done) / Math.max(1, stages.length)} label={running ? t(`mobileStep.stages.${running.id}`) : t("mobileStep.stagesTitle")} />
      <ol className="grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
        {stages.map((stage) => (
          <li key={stage.id} data-stage={stage.status} className={cn("flex min-w-0 items-center gap-1.5 text-[11px]", stage.status === "pending" && "text-muted-foreground")}>
            {stage.status === "running" ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-label={t("common.processing")} />
            ) : stage.status === "done" ? (
              <CheckCircle2 className="h-3 w-3 shrink-0 text-success" aria-label={t("common.progressDone")} />
            ) : stage.status === "failed" ? (
              <XCircle className="h-3 w-3 shrink-0 text-destructive" aria-label={t("status.FAILED")} />
            ) : (
              <Circle className="h-3 w-3 shrink-0 text-muted-foreground/50" aria-hidden />
            )}
            <span className="truncate">{t(`mobileStep.stages.${stage.id}`)}</span>
            {stage.detail ? <span className="truncate text-muted-foreground">· {detail(stage)}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The screenshot with a box over every element; a box selects its element. */
function ScreenView({ screen, selectedId, showText, onSelect }: { screen: Screen; selectedId: string | null; showText: boolean; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const boxes = screen.elements.filter((element) => element.bounds && (element.interactive || showText || element.id === selectedId));
  const pct = (value: number, of: number) => `${Math.max(0, Math.min(100, (100 * value) / Math.max(1, of)))}%`;
  return (
    <div className="relative mx-auto w-full max-w-72 overflow-hidden rounded-md border border-border bg-muted/30" style={{ aspectRatio: screen.width && screen.height ? `${screen.width} / ${screen.height}` : "9 / 19" }}>
      {screen.screenshot ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the device, not an optimizable asset
        <img src={screen.screenshot} alt={t("mobileStep.screenAlt")} className="absolute inset-0 h-full w-full object-fill" />
      ) : null}
      {boxes.map((element) => {
        const bounds = element.bounds!;
        const active = element.id === selectedId;
        return (
          <button
            key={element.id}
            type="button"
            aria-label={element.name}
            aria-pressed={active}
            title={element.name}
            className={cn(
              "absolute rounded-[2px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "border-primary bg-primary/25" : element.interactive ? "border-primary/40 hover:bg-primary/15" : "border-dashed border-muted-foreground/50 hover:bg-muted-foreground/10",
            )}
            style={{ left: pct(bounds.x, screen.width), top: pct(bounds.y, screen.height), width: pct(bounds.width, screen.width), height: pct(bounds.height, screen.height) }}
            onClick={() => onSelect(element.id)}
          />
        );
      })}
    </div>
  );
}

function ElementList({
  elements,
  selectedId,
  filter,
  onFilter,
  showText,
  onShowText,
  onSelect,
}: {
  elements: ScreenElement[];
  selectedId: string | null;
  filter: string;
  onFilter: (value: string) => void;
  showText: boolean;
  onShowText: (value: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const { t, n } = useI18n();
  const query = filter.trim().toLowerCase();
  const shown = elements.filter(
    (element) => (showText || element.interactive || element.id === selectedId) && (!query || `${element.name} ${Object.values(element.attributes).join(" ")}`.toLowerCase().includes(query)),
  );
  return (
    <details className="rounded-md border border-border" open>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t("mobileStep.elements", { count: n(shown.length) })}</summary>
      <div className="space-y-2 px-3 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <input className={cn(input, "h-7 max-w-56 flex-1")} placeholder={t("mobileStep.filter")} aria-label={t("mobileStep.filter")} value={filter} onChange={(event) => onFilter(event.target.value)} />
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={showText} onChange={(event) => onShowText(event.target.checked)} />
            {t("mobileStep.showText")}
          </label>
        </div>
        {shown.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("mobileStep.noElements")}</p>
        ) : (
          <ul className="max-h-48 space-y-0.5 overflow-auto">
            {shown.map((element) => (
              <li key={element.id}>
                <button
                  type="button"
                  aria-pressed={element.id === selectedId}
                  className={cn("flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-start text-xs", element.id === selectedId ? "bg-primary/15" : "hover:bg-accent")}
                  onClick={() => onSelect(element.id)}
                >
                  <BidiText text={element.name} className="min-w-0 flex-1 truncate" />
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground" dir="ltr">
                    {element.tag.split(".").pop()?.replace("XCUIElementType", "")}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {element.password ? t("mobileStep.password") : element.interactive ? t("mobileStep.interactive") : t("mobileStep.textOnly")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/** The chosen element: what it is, its ranked locators (choose which is tried first), and the actions for it. */
function ElementInspector({
  element,
  locatorIndex,
  onLocator,
  value,
  onValue,
  secret,
  onSecret,
  disabled,
  onAct,
}: {
  element: ScreenElement;
  locatorIndex: number;
  onLocator: (index: number) => void;
  value: string;
  onValue: (value: string) => void;
  secret: boolean;
  onSecret: (value: boolean) => void;
  disabled: boolean;
  onAct: (kind: MobileActionKind) => void;
}) {
  const { t } = useI18n();
  const kinds = ELEMENT_ACTIONS.filter((kind) => (kind === "type" || kind === "clear" ? element.editable : true));
  return (
    <section className="space-y-2 rounded-md border border-primary/40 p-2" aria-label={element.name}>
      <div className="flex min-w-0 items-center gap-2">
        <BidiText text={element.name} className="min-w-0 flex-1 truncate text-sm font-medium" />
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground" dir="ltr">
          {element.tag}
        </span>
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted-foreground">{t("mobileStep.attributes")}</summary>
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 font-mono" dir="ltr">
          {Object.entries(element.attributes).map(([key, item]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="truncate">{item}</dd>
            </div>
          ))}
        </dl>
      </details>
      <LocatorList locators={element.locators} chosen={locatorIndex} onChoose={onLocator} />
      <div className="space-y-1.5">
        <input
          className={cn(input, "h-7")}
          dir="auto"
          type={secret ? "password" : "text"}
          autoComplete="off"
          placeholder={element.editable ? t("mobileStep.textToType") : t("mobileStep.expectedText")}
          aria-label={element.editable ? t("mobileStep.textToType") : t("mobileStep.expectedText")}
          value={value}
          onChange={(event) => onValue(event.target.value)}
        />
        {element.editable ? (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={secret} disabled={element.password} onChange={(event) => onSecret(event.target.checked)} />
            {t("mobileStep.secret")}
          </label>
        ) : null}
        <div className="flex flex-wrap gap-1">
          {kinds.map((kind) => {
            const Icon = mobileActionIcon(kind);
            const needsValue = kind === "type" || kind === "assertText";
            return (
              <Button key={kind} size="sm" variant={kind === "tap" ? "default" : "outline"} disabled={disabled || (needsValue && !value)} onClick={() => onAct(kind)}>
                <Icon className="h-3.5 w-3.5" />
                {t(`mobileStep.actions.${kind}`)}
              </Button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Ranked locators with their score, uniqueness and the reasons for their place. */
export function LocatorList({ locators, chosen, onChoose }: { locators: MobileLocator[]; chosen: number; onChoose?: (index: number) => void }) {
  const { t, n } = useI18n();
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium">{t("mobileStep.locators")}</p>
      <p className="text-[10px] text-muted-foreground">{t("mobileStep.locatorsHint")}</p>
      <ol className="space-y-1">
        {locators.map((locator, index) => (
          <li key={`${locator.using}:${locator.value}`} className={cn("rounded border px-1.5 py-1", index === chosen ? "border-primary/60 bg-primary/5" : "border-border")}>
            <label className="flex min-w-0 items-start gap-1.5">
              {onChoose ? <input type="radio" className="mt-0.5" checked={index === chosen} onChange={() => onChoose(index)} aria-label={t("mobileStep.useFirst")} /> : null}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
                  <span className="shrink-0 font-mono text-[10px] text-primary" dir="ltr">
                    {locator.using}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[10px]" dir="ltr" title={locator.value}>
                    {locator.value}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                  {locator.score !== undefined ? <span className="font-mono">{n(Math.round(locator.score * 100))}%</span> : null}
                  {locator.unique === false ? (
                    <span className="text-warning">{t("mobileStep.matches", { count: n(locator.matches ?? 0) })}</span>
                  ) : locator.unique ? (
                    <span className="text-success">{t("mobileStep.unique")}</span>
                  ) : null}
                  {index === chosen ? <span className="text-primary">{t("mobileStep.preferred")}</span> : null}
                  {(locator.reasons ?? [])
                    .filter((reason) => reason !== "unique" && reason !== "notUnique")
                    .map((reason) => (
                      <span key={reason}>{t(`mobileStep.reasons.${reason}`)}</span>
                    ))}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The Actions tab of a mobile step: the device it runs on and its actions, editable; record more. */
export function MobileActionsTab({ step, onSave, onRecordMore }: { step: Step; onSave: (config: Record<string, unknown>) => Promise<void>; onRecordMore: () => void }) {
  const { t, n } = useI18n();
  const [platform, setPlatform] = useState<"android" | "ios">(step.config.platform === "ios" ? "ios" : "android");
  const [serverUrl, setServerUrl] = useState(String(step.config.serverUrl ?? DEFAULT_SERVER));
  const [capabilities, setCapabilities] = useState(JSON.stringify(step.config.capabilities ?? {}, null, 2));
  const [actions, setActions] = useState<MobileAction[]>(mobileActions(step.config));
  const [timeout, setTimeoutValue] = useState(String(step.config.actionTimeoutMs ?? 15000));
  const [newSession, setNewSession] = useState(step.config.newSession === true);
  const [open, setOpen] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);

  const parsedCapabilities = useMemo(() => {
    try {
      const parsed = JSON.parse(capabilities) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [capabilities]);

  const change = (next: MobileAction[]) => {
    setActions(next);
    setDirty(true);
  };
  const patch = (index: number, value: Partial<MobileAction>) => change(actions.map((action, at) => (at === index ? { ...action, ...value } : action)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...actions];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    change(next);
  };

  const save = async () => {
    if (!parsedCapabilities) return;
    setBusy(true);
    try {
      const timeoutMs = Number(timeout);
      await onSave({
        ...step.config,
        platform,
        serverUrl: serverUrl.trim(),
        capabilities: parsedCapabilities,
        actions,
        actionTimeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 15000,
        newSession: newSession || undefined,
      });
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onRecordMore}>
          <Smartphone className="h-3.5 w-3.5" />
          {t("uiStep.recordMore")}
        </Button>
      </div>

      {actions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{t("mobileStep.noActions")}</p>
      ) : (
        <ol ref={listRef} className="space-y-1.5" aria-label={t("uiStep.actions")}>
          {actions.map((action, index) => {
            const Icon = mobileActionIcon(action.kind);
            const hasValue = action.kind === "type" || action.kind === "assertText";
            const candidates = action.target?.candidates ?? [];
            const first = candidates[action.target?.learned ?? 0] ?? candidates[0];
            return (
              <li key={action.id} className={cn("space-y-1.5 rounded-md border px-2 py-1.5", action.optional ? "border-dashed border-border" : "border-border")}>
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-end font-mono text-[10px] text-muted-foreground">{n(index + 1)}</span>
                  <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={t(`mobileStep.actions.${action.kind}`)} />
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
                      className={cn(input, "h-7 max-w-72 flex-1")}
                      dir="auto"
                      type={action.secret ? "password" : "text"}
                      autoComplete="off"
                      placeholder={action.secret ? t("uiStep.secretKept") : action.kind === "type" ? t("mobileStep.textToType") : t("mobileStep.expectedText")}
                      value={action.secret && action.value === "••••••" ? "" : (action.value ?? "")}
                      aria-label={t("uiStep.value")}
                      onChange={(event) => patch(index, { value: event.target.value })}
                    />
                  ) : null}
                  {action.kind === "swipe" ? (
                    <select
                      className={cn(input, "h-7 w-36")}
                      aria-label={t("mobileStep.actions.swipe")}
                      value={action.direction ?? "up"}
                      onChange={(event) => patch(index, { direction: event.target.value as MobileAction["direction"], label: t(`mobileStep.swipe.${event.target.value}`) })}
                    >
                      {(["up", "down", "left", "right"] as const).map((direction) => (
                        <option key={direction} value={direction}>
                          {t(`mobileStep.swipe.${direction}`)}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {first ? (
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground hover:text-foreground"
                      dir="ltr"
                      aria-expanded={open === action.id}
                      onClick={() => setOpen(open === action.id ? null : action.id)}
                    >
                      <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open === action.id && "rotate-180")} aria-hidden />
                      <span className="truncate">
                        {first.using}: {first.value}
                      </span>
                      {first.score !== undefined ? <span>· {Math.round(first.score * 100)}%</span> : null}
                      {candidates.length > 1 ? <span>+{candidates.length - 1}</span> : null}
                    </button>
                  ) : null}
                  <label className="ms-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                    <input type="checkbox" checked={action.optional === true} onChange={(event) => patch(index, { optional: event.target.checked || undefined })} />
                    {t("uiStep.optional")}
                  </label>
                </div>
                {open === action.id && action.target ? (
                  <div className="ps-7">
                    <LocatorList
                      locators={candidates}
                      chosen={action.target.learned ?? 0}
                      onChoose={(choice) => patch(index, { target: { ...action.target!, learned: choice } })}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t("mobileStep.device")}</summary>
        <div className="space-y-2 px-3 pb-3">
          <fieldset className="flex flex-wrap items-center gap-3 text-xs">
            <legend className="sr-only">{t("mobileStep.platform")}</legend>
            {(["android", "ios"] as const).map((item) => (
              <label key={item} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={platform === item}
                  onChange={() => {
                    setPlatform(item);
                    setDirty(true);
                  }}
                />
                {t(`mobileStep.${item}`)}
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("mobileStep.serverUrl")}</span>
            <input
              className={cn(input, "font-mono")}
              dir="ltr"
              value={serverUrl}
              onChange={(event) => {
                setServerUrl(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("mobileStep.capabilities")}</span>
            <textarea
              className="min-h-28 w-full rounded-md border border-border bg-background p-2 font-mono text-[11px]"
              dir="ltr"
              spellCheck={false}
              value={capabilities}
              aria-invalid={!parsedCapabilities}
              onChange={(event) => {
                setCapabilities(event.target.value);
                setDirty(true);
              }}
            />
            {!parsedCapabilities ? <span className="text-[11px] text-destructive">{t("mobileStep.capabilitiesInvalid")}</span> : null}
          </label>
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
              checked={newSession}
              onChange={(event) => {
                setNewSession(event.target.checked);
                setDirty(true);
              }}
            />
            <span>
              {t("mobileStep.newSession")}
              <span className="block text-[11px] text-muted-foreground">{t("mobileStep.newSessionHint")}</span>
            </span>
          </label>
        </div>
      </details>

      <p className="text-[11px] text-muted-foreground">{t("uiStep.variablesHint")}</p>

      <div className="flex justify-end">
        <Button size="sm" disabled={!dirty || busy || !serverUrl.trim() || !parsedCapabilities} onClick={() => void save()}>
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
