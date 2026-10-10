"use client";

import { useState } from "react";
import { FlaskConical, Pencil, Trash2 } from "lucide-react";
import { BidiText, textDirection } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EditableList, EditableText, IconAction } from "@/components/workspace/editable";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-6";
const LEVELS = ["HIGH", "MEDIUM", "LOW"];

function LevelBadge({ value, prefix }: { value: string; prefix?: string }) {
  const { label } = useI18n();
  const tone = value === "HIGH" ? "border-destructive/40 text-destructive" : value === "MEDIUM" ? "border-warning/50 text-warning" : "border-border text-muted-foreground";
  return (
    <span className={cn("rounded border px-1.5 text-[10px]", tone)}>
      {prefix ? `${prefix}: ` : ""}
      {label("level", value)}
    </span>
  );
}

function useAction(onChanged: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { act, error, busy };
}

export type Strategy = { scope: string; objectives: string[]; testTypes: string[]; environments: string[]; dependencies: string[]; assumptions: string[] };

export function StrategyView({ issueId, strategy, onChanged }: { issueId: string; strategy: Strategy; onChanged: () => Promise<void> }) {
  const { t, err } = useI18n();
  const { act, error } = useAction(onChanged);
  const save = (patch: Partial<Strategy>) => act(() => api(`/analysis/${issueId}/strategy`, { method: "PATCH", body: JSON.stringify(patch) })).then(() => undefined);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>{t("studio.strategy.scope")}</CardTitle>
        </CardHeader>
        <CardContent>
          <EditableText value={strategy.scope} className="text-sm leading-7" onSave={(scope) => save({ scope })} />
        </CardContent>
      </Card>
      {(["objectives", "testTypes", "environments", "dependencies", "assumptions"] as const).map((key) => (
        <Card key={key}>
          <CardHeader>
            <CardTitle>{t(`studio.strategy.${key}`)}</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableList items={strategy[key] ?? []} addLabel={t("studio.add")} onSave={(items) => save({ [key]: items })} />
          </CardContent>
        </Card>
      ))}
      {error ? <p className="text-xs text-destructive md:col-span-2">{err(error)}</p> : null}
    </div>
  );
}

export type EdgeCase = { id: string; title: string; description: string; rationale?: string; severity?: string; ruleRefs?: string[]; acceptanceKeys?: string[]; manuallyEdited?: boolean };

export function EdgeCaseCard({ edge, onChanged }: { edge: EdgeCase; onChanged: () => Promise<void> }) {
  const { t, err } = useI18n();
  const { act, error, busy } = useAction(onChanged);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: edge.title, description: edge.description, rationale: edge.rationale ?? "", severity: edge.severity ?? "MEDIUM" });
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        {editing ? (
          <div className="space-y-2">
            <input className={cn(field, "h-8 py-0 font-medium")} dir={textDirection(draft.title)} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            <textarea className={cn(field, "min-h-24")} dir={textDirection(draft.description)} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            <label className="block space-y-1 text-[11px] text-muted-foreground">
              {t("studio.edges.why")}
              <textarea className={cn(field, "min-h-14")} dir={textDirection(draft.rationale)} value={draft.rationale} onChange={(event) => setDraft({ ...draft, rationale: event.target.value })} />
            </label>
            <select className={cn(field, "h-8 w-auto py-0")} value={draft.severity} onChange={(event) => setDraft({ ...draft, severity: event.target.value })}>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`level.${level}`)}
                </option>
              ))}
            </select>
            <div className="flex gap-1.5">
              <Button size="sm" disabled={busy || !draft.title.trim()} onClick={() => void act(() => api(`/analysis/edge-cases/${edge.id}`, { method: "PATCH", body: JSON.stringify(draft) })).then((ok) => ok && setEditing(false))}>
                {t("studio.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t("studio.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <BidiText text={edge.title} className="block min-w-0 flex-1 text-sm font-medium leading-6" />
              {edge.severity ? <LevelBadge value={edge.severity} /> : null}
              <span className="flex">
                <IconAction label={t("studio.edges.toCase")} onClick={() => void act(() => api(`/analysis/edge-cases/${edge.id}/test-case`, { method: "POST", body: "{}" }))}>
                  <FlaskConical className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction label={t("studio.edit")} onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction label={t("studio.delete")} danger onClick={() => void act(() => api(`/analysis/edge-cases/${edge.id}`, { method: "DELETE" }))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconAction>
              </span>
            </div>
            <BidiText text={edge.description} className="block whitespace-pre-wrap text-xs leading-5" />
            {edge.rationale ? <BidiText text={`${t("studio.edges.why")}: ${edge.rationale}`} className="block text-[11px] text-muted-foreground" /> : null}
            {edge.acceptanceKeys?.length || edge.ruleRefs?.length ? (
              <div className="flex flex-wrap gap-1" dir="ltr">
                {[...(edge.acceptanceKeys ?? []), ...(edge.ruleRefs ?? [])].map((key) => (
                  <span key={key} className="rounded bg-muted px-1 font-mono text-[10px]">
                    {key}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
        {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}
      </CardContent>
    </Card>
  );
}

export type RiskView = { id: string; description: string; impact: string; likelihood: string; mitigation: string; releaseBlocking?: boolean; acceptanceKeys?: string[] };

export function RiskCard({ risk, onChanged }: { risk: RiskView; onChanged: () => Promise<void> }) {
  const { t, err } = useI18n();
  const { act, error, busy } = useAction(onChanged);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ ...risk, releaseBlocking: Boolean(risk.releaseBlocking) });
  return (
    <Card className={risk.releaseBlocking ? "border-destructive/50" : undefined}>
      <CardContent className="space-y-2 p-3">
        {editing ? (
          <div className="space-y-2">
            <textarea className={cn(field, "min-h-16")} dir={textDirection(draft.description)} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            <label className="block space-y-1 text-[11px] text-muted-foreground">
              {t("studio.risks.mitigation")}
              <textarea className={cn(field, "min-h-14")} dir={textDirection(draft.mitigation)} value={draft.mitigation} onChange={(event) => setDraft({ ...draft, mitigation: event.target.value })} />
            </label>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(["impact", "likelihood"] as const).map((key) => (
                <label key={key} className="flex items-center gap-1 text-muted-foreground">
                  {t(`studio.risks.${key}`)}
                  <select className={cn(field, "h-8 w-auto py-0")} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}>
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`level.${level}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.releaseBlocking} onChange={(event) => setDraft({ ...draft, releaseBlocking: event.target.checked })} />
                {t("workspace.blocksProduction")}
              </label>
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                disabled={busy || !draft.description.trim()}
                onClick={() =>
                  void act(() =>
                    api(`/analysis/risks/${risk.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ description: draft.description, mitigation: draft.mitigation, impact: draft.impact, likelihood: draft.likelihood, releaseBlocking: draft.releaseBlocking }),
                    }),
                  ).then((ok) => ok && setEditing(false))
                }
              >
                {t("studio.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t("studio.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <BidiText text={risk.description} className="block min-w-0 flex-1 text-sm leading-6" />
              <span className="flex">
                <IconAction label={t("studio.edit")} onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction label={t("studio.delete")} danger onClick={() => void act(() => api(`/analysis/risks/${risk.id}`, { method: "DELETE" }))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconAction>
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <LevelBadge value={risk.impact} prefix={t("studio.risks.impact")} />
              <LevelBadge value={risk.likelihood} prefix={t("studio.risks.likelihood")} />
              {risk.releaseBlocking ? <span className="rounded border border-destructive/40 bg-destructive/10 px-1.5 text-[10px] text-destructive">{t("workspace.blocksProduction")}</span> : null}
              {(risk.acceptanceKeys ?? []).map((key) => (
                <span key={key} className="rounded bg-muted px-1 font-mono text-[10px]" dir="ltr">
                  {key}
                </span>
              ))}
            </div>
            {risk.mitigation ? <BidiText text={`${t("studio.risks.mitigation")}: ${risk.mitigation}`} className="block text-xs text-muted-foreground" /> : null}
          </>
        )}
        {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}
      </CardContent>
    </Card>
  );
}

export type AutomationView = {
  id: string;
  recommendedLevel: string;
  apiUiRecommendation: string;
  reasoning: string;
  prerequisites?: string[];
  tooling?: string;
  testCaseId?: string | null;
};

export function AutomationCard({ item, caseTitle, onChanged }: { item: AutomationView; caseTitle?: string; onChanged: () => Promise<void> }) {
  const { t, label, err } = useI18n();
  const { act, error, busy } = useAction(onChanged);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    recommendedLevel: item.recommendedLevel,
    apiUiRecommendation: item.apiUiRecommendation,
    reasoning: item.reasoning,
    tooling: item.tooling ?? "",
    prerequisites: (item.prerequisites ?? []).join("\n"),
  });
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {caseTitle ? <BidiText text={caseTitle} className="block text-sm font-medium leading-6" /> : null}
            <div className="mt-1 flex flex-wrap gap-1.5">
              <LevelBadge value={item.recommendedLevel} prefix={t("studio.automation.suitability")} />
              <span className="rounded border border-primary/40 px-1.5 text-[10px] text-primary">{label("automationLayer", item.apiUiRecommendation)}</span>
            </div>
          </div>
          {!editing ? (
            <span className="flex">
              <IconAction label={t("studio.edit")} onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction label={t("studio.delete")} danger onClick={() => void act(() => api(`/analysis/automation/${item.id}`, { method: "DELETE" }))}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconAction>
            </span>
          ) : null}
        </div>
        {editing ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <select className={cn(field, "h-8 w-auto py-0")} value={draft.recommendedLevel} onChange={(event) => setDraft({ ...draft, recommendedLevel: event.target.value })}>
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`level.${level}`)}
                  </option>
                ))}
              </select>
              <select className={cn(field, "h-8 w-auto py-0")} value={draft.apiUiRecommendation} onChange={(event) => setDraft({ ...draft, apiUiRecommendation: event.target.value })}>
                {["API", "UI", "DB", "Integration", "Manual"].map((layer) => (
                  <option key={layer} value={layer}>
                    {label("automationLayer", layer)}
                  </option>
                ))}
              </select>
            </div>
            <textarea className={cn(field, "min-h-16")} dir={textDirection(draft.reasoning)} value={draft.reasoning} onChange={(event) => setDraft({ ...draft, reasoning: event.target.value })} />
            <label className="block space-y-1 text-[11px] text-muted-foreground">
              {t("studio.automation.prerequisitesHint")}
              <textarea className={cn(field, "min-h-14")} dir={textDirection(draft.prerequisites)} value={draft.prerequisites} onChange={(event) => setDraft({ ...draft, prerequisites: event.target.value })} />
            </label>
            <input className={cn(field, "h-8 py-0")} placeholder={t("studio.automation.tooling")} dir={textDirection(draft.tooling)} value={draft.tooling} onChange={(event) => setDraft({ ...draft, tooling: event.target.value })} />
            <div className="flex gap-1.5">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api(`/analysis/automation/${item.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ ...draft, prerequisites: draft.prerequisites.split("\n").map((line) => line.trim()).filter(Boolean) }),
                    }),
                  ).then((ok) => ok && setEditing(false))
                }
              >
                {t("studio.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t("studio.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <BidiText text={item.reasoning} className="block text-xs leading-5" />
            {item.prerequisites?.length ? (
              <ul className="list-disc space-y-0.5 ps-5 text-[11px] text-muted-foreground">
                {item.prerequisites.map((pre, index) => (
                  <li key={index}>
                    <BidiText text={pre} />
                  </li>
                ))}
              </ul>
            ) : null}
            {item.tooling ? <BidiText text={`${t("studio.automation.tooling")}: ${item.tooling}`} className="block text-[11px] text-muted-foreground" /> : null}
          </>
        )}
        {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}
      </CardContent>
    </Card>
  );
}
