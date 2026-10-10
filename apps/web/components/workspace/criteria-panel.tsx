"use client";

import { useState } from "react";
import { Check, FlaskConical, Plus, Trash2, X } from "lucide-react";
import { BidiText, textDirection } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { EditableText, IconAction } from "@/components/workspace/editable";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type Criterion = {
  id: string;
  key: string;
  text: string;
  origin?: string;
  evidence?: string;
  confidence?: string | null;
  rationale?: string;
  category?: string | null;
};

const PROPOSAL = new Set(["ai", "derived"]);

function OriginBadge({ origin }: { origin?: string }) {
  const { t } = useI18n();
  const known = ["imported", "cleaned", "manual", "ai", "derived", "confirmed", "edited"];
  const key = known.includes(origin ?? "") ? origin! : "imported";
  return (
    <span
      className={cn(
        "rounded border px-1.5 text-[10px]",
        PROPOSAL.has(key) ? "border-primary/50 text-primary" : key === "confirmed" || key === "manual" ? "border-success/40 text-success" : "border-border text-muted-foreground",
      )}
    >
      {t(`studio.criteria.origin.${key}`)}
    </span>
  );
}

/** Acceptance criteria: written ones, the user's own, and AI proposals to confirm or reject. */
export function CriteriaPanel({
  issueId,
  criteria,
  running,
  onChanged,
  onGenerateFor,
}: {
  issueId: string;
  criteria: Criterion[];
  running: boolean;
  onChanged: () => Promise<void>;
  onGenerateFor: (key: string) => void;
}) {
  const { t, err } = useI18n();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const proposals = criteria.filter((item) => PROPOSAL.has(item.origin ?? ""));

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  };

  return (
    <section className="space-y-2" aria-labelledby="criteria-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="criteria-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("studio.criteria.title")}
        </h2>
        {proposals.length > 0 ? (
          <span className="text-[11px] text-primary">{t("studio.criteria.proposalsHint", { count: String(proposals.length) })}</span>
        ) : null}
        <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t("studio.criteria.add")}
        </Button>
      </div>
      {criteria.length === 0 ? <p className="text-xs text-muted-foreground">{t("studio.criteria.none")}</p> : null}
      <ul className="space-y-1.5">
        {criteria.map((item) => {
          const proposal = PROPOSAL.has(item.origin ?? "");
          return (
            <li key={item.id} className={cn("rounded-md border px-2.5 py-2", proposal ? "border-primary/40 bg-primary/5" : "border-border")}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-primary" dir="ltr">
                  {item.key}
                </span>
                <OriginBadge origin={item.origin} />
                {proposal && item.confidence ? (
                  <span
                    className={cn(
                      "rounded border px-1.5 text-[10px]",
                      item.confidence === "HIGH" ? "border-success/40 text-success" : item.confidence === "MEDIUM" ? "border-primary/40 text-primary" : "border-warning/50 text-warning",
                    )}
                  >
                    {t(`studio.confidence.${item.confidence}`)}
                  </span>
                ) : null}
                <span className="ms-auto flex items-center">
                  {proposal ? (
                    <>
                      <IconAction label={t("studio.criteria.confirm")} onClick={() => void act(() => api(`/analysis/criteria/${item.id}`, { method: "PATCH", body: JSON.stringify({ confirm: true }) }))}>
                        <Check className="h-3.5 w-3.5 text-success" />
                      </IconAction>
                      <IconAction label={t("studio.criteria.reject")} danger onClick={() => void act(() => api(`/analysis/criteria/${item.id}`, { method: "DELETE" }))}>
                        <X className="h-3.5 w-3.5" />
                      </IconAction>
                    </>
                  ) : item.origin !== "imported" && item.origin !== "cleaned" ? (
                    <IconAction
                      label={t("studio.delete")}
                      danger
                      onClick={() => {
                        if (window.confirm(t("common.confirmDelete", { name: item.key }))) void act(() => api(`/analysis/criteria/${item.id}`, { method: "DELETE" }));
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconAction>
                  ) : null}
                  <IconAction label={t("studio.criteria.generateFor")} onClick={() => !running && onGenerateFor(item.key)}>
                    <FlaskConical className={cn("h-3.5 w-3.5", running && "opacity-40")} />
                  </IconAction>
                </span>
              </div>
              <div className="mt-1">
                <EditableText
                  value={item.text}
                  className="text-sm leading-6"
                  onSave={(text) => act(() => api(`/analysis/criteria/${item.id}`, { method: "PATCH", body: JSON.stringify({ text }) }))}
                />
              </div>
              {proposal && (item.evidence || item.rationale) ? (
                <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  {item.evidence ? <BidiText text={`${t("studio.criteria.evidence")}: «${item.evidence}»`} className="block" /> : null}
                  {item.rationale ? <BidiText text={item.rationale} className="block" /> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {adding ? (
        <div className="space-y-1.5 rounded-md border border-border p-2">
          <textarea
            autoFocus
            dir={textDirection(draft)}
            className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            placeholder={t("studio.criteria.addPlaceholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={!draft.trim()}
              onClick={() =>
                void act(() => api(`/analysis/${issueId}/criteria`, { method: "POST", body: JSON.stringify({ text: draft }) })).then(() => {
                  setDraft("");
                  setAdding(false);
                })
              }
            >
              {t("studio.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {t("studio.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}
    </section>
  );
}
