"use client";

import { useState } from "react";
import { BadgeCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { BidiText, textDirection } from "@/components/bidi-text";
import { MediaGallery, MediaPicker, type MediaItem } from "@/components/media-attachments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { IconAction } from "@/components/workspace/editable";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type TestCaseView = {
  id: string;
  title: string;
  priority: string;
  type: string;
  steps: string[];
  stepExpectations?: string[];
  testData?: string[];
  description?: string;
  expectedResult: string;
  preconditions: string[];
  tags?: string[];
  designStatus?: string;
  technique?: string;
  gapRefs?: string[];
  assumptions?: string[];
  automationSuitability?: string | null;
  automationNotes?: string;
  executionNotes?: string;
  executionEvidence?: string;
  jiraSyncStatus?: string;
  jiraSyncError?: string | null;
  acceptanceLinks: Array<{ acceptanceCriterion: { key: string; text: string } }>;
  runs: Array<{ id: string; status: string; notes?: string | null; evidence?: string | null; executedAt: string }>;
};

const STATUSES = ["PASSED", "FAILED", "BLOCKED", "SKIPPED"] as const;
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const TYPES = ["FUNCTIONAL", "NEGATIVE", "BOUNDARY", "SECURITY", "INTEGRATION", "UI", "PERFORMANCE", "DATA"];
const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-6";

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone =
    status === "PASSED"
      ? "border-success/40 bg-success/10 text-success"
      : status === "FAILED"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : status === "BLOCKED"
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-border bg-secondary text-muted-foreground";
  return <Badge className={tone}>{label}</Badge>;
}

function DesignBadge({ status }: { status?: string }) {
  const { t, label } = useI18n();
  if (!status) return null;
  const tone =
    status === "APPROVED"
      ? "border-success/40 text-success"
      : status === "DRAFT_REQUIRES_REVIEW" || status === "POTENTIALLY_OUTDATED"
        ? "border-warning/50 text-warning"
        : "border-border text-muted-foreground";
  return (
    <span className={cn("rounded border px-1.5 text-[10px]", tone)} title={t("workspace.designStatus")}>
      {label("workspace.designStatuses", status)}
    </span>
  );
}

type Draft = {
  title: string;
  description: string;
  preconditions: string;
  testData: string;
  steps: Array<{ action: string; expected: string }>;
  expectedResult: string;
  priority: string;
  type: string;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** One test case: read it, correct it (the analysis learns from the correction), approve, run it. */
export function TestCaseCard({
  testCase,
  selected,
  onSelect,
  notes,
  evidence,
  onNotes,
  onEvidence,
  onSaveNotes,
  onRun,
  media,
  onUpload,
  onRemoveMedia,
  busy,
  onChanged,
}: {
  testCase: TestCaseView;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  notes: string;
  evidence: string;
  onNotes: (value: string) => void;
  onEvidence: (value: string) => void;
  onSaveNotes: () => void;
  onRun: (status: string) => void;
  media: MediaItem[];
  onUpload: (files: File[]) => void;
  onRemoveMedia: (attachmentId: string) => void;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t, n, label, err } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tc = testCase;
  const status = tc.runs[0]?.status ?? "NOT_RUN";
  const statusLabel = (value: string) => {
    const translated = t(`status.${value}`);
    return translated === `status.${value}` ? value : translated;
  };

  const startEdit = () => {
    setDraft({
      title: tc.title,
      description: tc.description ?? "",
      preconditions: (tc.preconditions ?? []).join("\n"),
      testData: (tc.testData ?? []).join("\n"),
      steps: (tc.steps ?? []).map((action, index) => ({ action, expected: tc.stepExpectations?.[index] ?? "" })),
      expectedResult: tc.expectedResult,
      priority: tc.priority,
      type: tc.type,
    });
    setEditing(true);
  };

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    setSaving(true);
    try {
      await work();
      await onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    const steps = draft.steps.filter((step) => step.action.trim());
    const ok = await act(() =>
      api(`/test-cases/${tc.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: draft.title.trim(),
          description: draft.description.trim(),
          preconditions: lines(draft.preconditions),
          testData: lines(draft.testData),
          steps: steps.map((step) => step.action.trim()),
          stepExpectations: steps.map((step) => step.expected.trim()),
          expectedResult: draft.expectedResult.trim(),
          priority: draft.priority,
          type: draft.type,
        }),
      }),
    );
    if (ok) setEditing(false);
  };

  return (
    <Card className={cn(tc.designStatus === "POTENTIALLY_OUTDATED" && "opacity-75")}>
      <CardContent className="space-y-2.5 p-3">
        <div className="flex items-start gap-2">
          <input type="checkbox" className="mt-1.5" aria-label={tc.title} checked={selected} onChange={(event) => onSelect(event.target.checked)} />
          <div className="min-w-0 flex-1">
            {editing && draft ? (
              <input className={cn(field, "h-8 py-0 font-medium")} dir={textDirection(draft.title)} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            ) : (
              <BidiText text={tc.title} className="block text-sm font-medium leading-6" />
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <DesignBadge status={tc.designStatus} />
              <span>{label("level", tc.priority)}</span>
              <span>·</span>
              <span>{label("caseType", tc.type)}</span>
              {tc.acceptanceLinks.map((link) => (
                <span key={link.acceptanceCriterion.key} className="rounded bg-muted px-1 font-mono text-[10px]" dir="ltr">
                  {link.acceptanceCriterion.key}
                </span>
              ))}
              {tc.jiraSyncStatus && tc.jiraSyncStatus !== "NOT_SYNCED" ? <span>· {t(`workspace.syncStatus.${tc.jiraSyncStatus}`)}</span> : null}
            </div>
          </div>
          <StatusBadge status={status} label={statusLabel(status)} />
          {!editing ? (
            <span className="flex">
              {tc.designStatus !== "APPROVED" ? (
                <IconAction label={t("studio.cases.approve")} onClick={() => void act(() => api(`/test-cases/${tc.id}/approve`, { method: "POST", body: "{}" }))}>
                  <BadgeCheck className="h-4 w-4" />
                </IconAction>
              ) : null}
              <IconAction label={t("studio.edit")} onClick={startEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction
                label={t("studio.delete")}
                danger
                onClick={() => {
                  if (window.confirm(t("common.confirmDelete", { name: tc.title }))) void act(() => api(`/test-cases/${tc.id}`, { method: "DELETE" }));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconAction>
            </span>
          ) : null}
        </div>

        {editing && draft ? (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-[11px] text-muted-foreground">
                {t("studio.cases.priority")}
                <select className={cn(field, "h-8 py-0")} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>
                  {PRIORITIES.map((item) => (
                    <option key={item} value={item}>
                      {label("level", item)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-muted-foreground">
                {t("studio.cases.type")}
                <select className={cn(field, "h-8 py-0")} value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
                  {[...new Set([...TYPES, draft.type])].map((item) => (
                    <option key={item} value={item}>
                      {label("caseType", item)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block space-y-1 text-[11px] text-muted-foreground">
              {t("workspace.objective")}
              <textarea className={cn(field, "min-h-14")} dir={textDirection(draft.description)} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label className="block space-y-1 text-[11px] text-muted-foreground">
              {t("studio.cases.preconditionsHint")}
              <textarea className={cn(field, "min-h-14")} dir={textDirection(draft.preconditions)} value={draft.preconditions} onChange={(event) => setDraft({ ...draft, preconditions: event.target.value })} />
            </label>
            <fieldset className="space-y-1.5">
              <legend className="text-[11px] text-muted-foreground">{t("common.steps")}</legend>
              {draft.steps.map((step, index) => (
                <div key={index} className="grid gap-1.5 rounded-md border border-border p-2 sm:grid-cols-[auto_1fr_1fr_auto]">
                  <span className="pt-1.5 font-mono text-[11px] text-muted-foreground">{n(index + 1)}</span>
                  <textarea
                    aria-label={t("workspace.action")}
                    placeholder={t("workspace.action")}
                    className={cn(field, "min-h-12")}
                    dir={textDirection(step.action)}
                    value={step.action}
                    onChange={(event) => setDraft({ ...draft, steps: draft.steps.map((item, i) => (i === index ? { ...item, action: event.target.value } : item)) })}
                  />
                  <textarea
                    aria-label={t("workspace.stepExpected")}
                    placeholder={t("workspace.stepExpected")}
                    className={cn(field, "min-h-12")}
                    dir={textDirection(step.expected)}
                    value={step.expected}
                    onChange={(event) => setDraft({ ...draft, steps: draft.steps.map((item, i) => (i === index ? { ...item, expected: event.target.value } : item)) })}
                  />
                  <IconAction label={t("studio.delete")} danger onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconAction>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { action: "", expected: "" }] })}>
                <Plus className="h-3.5 w-3.5" />
                {t("studio.cases.addStep")}
              </Button>
            </fieldset>
            <label className="block space-y-1 text-[11px] text-muted-foreground">
              {t("studio.cases.testDataHint")}
              <textarea className={cn(field, "min-h-14 font-mono text-xs")} dir="ltr" value={draft.testData} onChange={(event) => setDraft({ ...draft, testData: event.target.value })} />
            </label>
            <label className="block space-y-1 text-[11px] text-muted-foreground">
              {t("workspace.finalExpected")}
              <textarea className={cn(field, "min-h-14")} dir={textDirection(draft.expectedResult)} value={draft.expectedResult} onChange={(event) => setDraft({ ...draft, expectedResult: event.target.value })} />
            </label>
            <p className="text-[11px] text-muted-foreground">{t("studio.cases.learnHint")}</p>
            <div className="flex gap-1.5">
              <Button size="sm" disabled={saving || !draft.title.trim() || !draft.expectedResult.trim() || !draft.steps.some((step) => step.action.trim())} onClick={() => void save()}>
                {t("studio.save")}
              </Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
                {t("studio.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {tc.description ? <BidiText text={tc.description} className="block text-xs leading-5 text-muted-foreground" /> : null}
            {tc.preconditions?.length ? (
              <div className="space-y-0.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("common.preconditions")}</div>
                <ul className="list-disc space-y-0.5 ps-5 text-xs leading-5">
                  {tc.preconditions.map((item, index) => (
                    <li key={index}>
                      <BidiText text={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ol className="space-y-1">
              {(tc.steps ?? []).map((step, index) => (
                <li key={index} className="grid grid-cols-[1.5rem_1fr] gap-x-2 rounded-md border border-border px-2 py-1.5 text-xs leading-5 sm:grid-cols-[1.5rem_1fr_1fr]">
                  <span className="font-mono text-[11px] text-muted-foreground">{n(index + 1)}</span>
                  <BidiText text={step} />
                  {tc.stepExpectations?.[index] ? (
                    <BidiText text={tc.stepExpectations[index]} className="col-start-2 text-muted-foreground sm:col-start-3" />
                  ) : null}
                </li>
              ))}
            </ol>
            {tc.testData?.length ? (
              <div className="space-y-0.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("workspace.testData")}</div>
                <ul className="space-y-0.5 text-xs">
                  {tc.testData.map((item, index) => (
                    <li key={index}>
                      <BidiText text={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="rounded-md bg-muted/60 px-2 py-1.5 text-xs leading-5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("workspace.finalExpected")}</span>
              <BidiText text={tc.expectedResult} className="block" />
            </div>
            {tc.assumptions?.length ? <BidiText text={tc.assumptions.join(" · ")} className="block text-[11px] text-warning" /> : null}
            {tc.automationNotes ? (
              <BidiText text={`${t("studio.cases.automation")}: ${label("level", tc.automationSuitability ?? "")} — ${tc.automationNotes}`} className="block text-[11px] text-muted-foreground" />
            ) : null}
          </>
        )}
        {tc.jiraSyncError ? <p className="text-xs text-destructive">{err(tc.jiraSyncError)}</p> : null}
        {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}

        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">{t("studio.cases.execution")}</summary>
          <div className="space-y-2 p-2">
            <div className="grid gap-2 md:grid-cols-2">
              <textarea className={cn(field, "min-h-16 text-xs")} placeholder={t("common.notes")} dir={textDirection(notes)} value={notes} onChange={(event) => onNotes(event.target.value)} />
              <textarea className={cn(field, "min-h-16 text-xs")} placeholder={t("common.evidence")} dir={textDirection(evidence)} value={evidence} onChange={(event) => onEvidence(event.target.value)} />
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={onSaveNotes}>
              {t("workspace.saveNotes")}
            </Button>
            <MediaGallery items={media} removeLabel={t("common.delete")} onRemove={onRemoveMedia} />
            <MediaPicker label={t("common.media")} hint={t("common.mediaHint")} disabled={busy} onFiles={onUpload} />
          </div>
        </details>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((item) => (
            <Button key={item} size="sm" variant="outline" className="min-w-[4.75rem]" disabled={busy} onClick={() => onRun(item)}>
              {statusLabel(item)}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
