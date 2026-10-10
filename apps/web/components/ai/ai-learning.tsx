"use client";

import { useCallback, useEffect, useState } from "react";
import { GraduationCap, Plus, Trash2 } from "lucide-react";
import { BidiText, textDirection } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EditableText, IconAction } from "@/components/workspace/editable";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Guideline = { id: string; scope: string; text: string; source: "manual" | "learned"; enabled: boolean };
type Feedback = { id: string; artifact: string; action: string; createdAt: string; learned: boolean };
type Overview = { guidelines: Guideline[]; feedback: Feedback[]; pending: number; distilling: boolean };

const SCOPES = ["all", "criteria", "questions", "testCases", "edgeCases", "risks", "strategy", "automation", "summary"];

/**
 * What the analysis has learned from the team's corrections, and the team's
 * own rules — all visible, editable and reversible.
 */
export function AiLearning() {
  const { t, n, d, err } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [draft, setDraft] = useState({ scope: "all", text: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setData(await api<Overview>("/ai/learning")), []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? err(e.message) : t("errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  const guidelines = data?.guidelines ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <GraduationCap className="h-4 w-4" />
          {t("learning.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("learning.hint")}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("learning.pending", { count: n(data?.pending ?? 0) })}</span>
          <Button size="sm" variant="outline" disabled={busy || data?.distilling || (data?.feedback.length ?? 0) === 0} onClick={() => void run(() => api("/ai/learning/distill", { method: "POST", body: "{}" }))}>
            {data?.distilling || busy ? t("learning.learning") : t("learning.learnNow")}
          </Button>
        </div>

        <ul className="space-y-1.5">
          {guidelines.map((item) => (
            <li key={item.id} className={cn("flex items-start gap-2 rounded-md border px-2 py-1.5", item.enabled ? "border-border" : "border-dashed border-border opacity-60")}>
              <input type="checkbox" className="mt-1.5" aria-label={t("learning.enabled")} checked={item.enabled} onChange={(event) => void run(() => api(`/ai/learning/guidelines/${item.id}`, { method: "PATCH", body: JSON.stringify({ enabled: event.target.checked }) }))} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <EditableText value={item.text} multiline={false} className="text-sm" onSave={(text) => run(() => api(`/ai/learning/guidelines/${item.id}`, { method: "PATCH", body: JSON.stringify({ text }) }))} />
                <div className="flex gap-2 text-[10px] text-muted-foreground">
                  <span>{t(`learning.scopes.${item.scope}`)}</span>
                  <span>·</span>
                  <span>{item.source === "learned" ? t("learning.learned") : t("learning.manual")}</span>
                </div>
              </div>
              <IconAction label={t("studio.delete")} danger onClick={() => void run(() => api(`/ai/learning/guidelines/${item.id}`, { method: "DELETE" }))}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconAction>
            </li>
          ))}
        </ul>
        {guidelines.length === 0 ? <p className="text-xs text-muted-foreground">{t("learning.none")}</p> : null}

        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.text.trim()) void run(() => api("/ai/learning/guidelines", { method: "POST", body: JSON.stringify(draft) }).then(() => setDraft({ scope: draft.scope, text: "" })));
          }}
        >
          <select className="h-8 rounded-md border border-border bg-background px-2 text-xs" value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value })}>
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {t(`learning.scopes.${scope}`)}
              </option>
            ))}
          </select>
          <input
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
            dir={textDirection(draft.text)}
            placeholder={t("learning.addPlaceholder")}
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <Button type="submit" size="sm" disabled={busy || !draft.text.trim()}>
            <Plus className="h-3.5 w-3.5" />
            {t("learning.add")}
          </Button>
        </form>

        {data?.feedback.length ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t("learning.recent", { count: n(data.feedback.length) })}</summary>
            <ul className="mt-1 space-y-0.5">
              {data.feedback.map((item) => (
                <li key={item.id} className="flex gap-2 text-[11px] text-muted-foreground">
                  <span>{d(item.createdAt)}</span>
                  <BidiText text={`${t(`learning.artifacts.${item.artifact}`)} · ${t(`learning.actions.${item.action}`)}`} />
                  {item.learned ? <span className="text-success">✓</span> : null}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => window.confirm(t("learning.forgetConfirm")) && void run(() => api("/ai/learning/forget", { method: "POST", body: JSON.stringify({ feedback: true }) }))}>
                {t("learning.forgetFeedback")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => window.confirm(t("learning.forgetConfirm")) && void run(() => api("/ai/learning/forget", { method: "POST", body: JSON.stringify({ learned: true }) }))}>
                {t("learning.forgetLearned")}
              </Button>
            </div>
          </details>
        ) : null}
        {message ? <p className="text-xs text-destructive">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
