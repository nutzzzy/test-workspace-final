"use client";

import { ChevronRight } from "lucide-react";
import { BidiText } from "@/components/bidi-text";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EditableList, EditableText } from "@/components/workspace/editable";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type Understanding = {
  summary?: string;
  actors?: Array<{ name: string; description?: string }>;
  entities?: Array<{ name: string; description?: string; fields?: Array<{ name: string; type?: string; notes?: string }> }>;
  states?: Array<{ name: string; meaning?: string }>;
  transitions?: Array<{ from: string; to: string; trigger?: string; conditions?: string }>;
  rules?: Array<{ id: string; text: string; evidence?: string; grounded?: boolean; source?: string }>;
  apis?: Array<{ method: string; path: string; purpose?: string; request?: string; responses?: string[]; auth?: string }>;
  configurations?: Array<{ key: string; meaning?: string }>;
  calculations?: Array<{ name: string; formula: string; meaning?: string }>;
  flows?: Array<{ name: string; steps?: string[] }>;
  integrations?: string[];
  nonFunctional?: string[];
  assumptions?: string[];
  outOfScope?: string[];
};

export type RequirementAnalysis = {
  summary: string;
  gaps: string[];
  ambiguities: string[];
  questionsProduct: string[];
  questionsDeveloper: string[];
  questionsBusiness: string[];
  questionDetails?: Array<{ question: string; category: string; reason: string; source: string }>;
  understanding?: Understanding & { _edited?: string[] };
};

function Section({ title, count, children, open }: { title: string; count?: number; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-md border border-border bg-card" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90 rtl:-scale-x-100 rtl:group-open:rotate-90" />
        {title}
        {count !== undefined ? <span className="text-[10px] font-normal text-muted-foreground">({count})</span> : null}
      </summary>
      <div className="border-t border-border px-3 py-2">{children}</div>
    </details>
  );
}

/** The analysis of the requirement: what the model understood, and what is missing. Everything editable is editable. */
export function RequirementsView({
  analysis,
  onSave,
}: {
  analysis: RequirementAnalysis;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const { t, n } = useI18n();
  const u = analysis.understanding ?? {};
  const reasonOf = (question: string) => analysis.questionDetails?.find((item) => item.question === question)?.reason;

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>{t("studio.req.summary")}</CardTitle>
        </CardHeader>
        <CardContent>
          <EditableText value={analysis.summary} className="text-sm leading-7" onSave={(summary) => onSave({ summary })} />
        </CardContent>
      </Card>

      {u.rules?.length ? (
        <Section title={t("studio.req.rules")} count={u.rules.length} open>
          <ol className="space-y-1.5">
            {u.rules.map((rule) => (
              <li key={rule.id} className="flex gap-2 text-sm leading-6">
                <span className="shrink-0 font-mono text-[11px] text-primary" dir="ltr">
                  {rule.id}
                </span>
                <div className="min-w-0 flex-1">
                  <BidiText text={rule.text} />
                  {rule.evidence ? (
                    <BidiText
                      text={`«${rule.evidence}»${rule.grounded === false ? ` — ${t("studio.req.notFound")}` : ""}`}
                      className={cn("block text-[11px]", rule.grounded === false ? "text-warning" : "text-muted-foreground")}
                    />
                  ) : null}
                </div>
                {rule.source === "document" ? <span className="h-fit shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">PRD</span> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {u.apis?.length ? (
        <Section title={t("studio.req.apis")} count={u.apis.length}>
          <ul className="space-y-2">
            {u.apis.map((api, index) => (
              <li key={index} className="space-y-0.5 text-sm">
                <div className="font-mono text-xs" dir="ltr">
                  <span className="font-semibold text-primary">{api.method}</span> {api.path}
                  {api.responses?.length ? <span className="text-muted-foreground"> → {api.responses.join(", ")}</span> : null}
                </div>
                {api.purpose ? <BidiText text={api.purpose} className="block text-xs text-muted-foreground" /> : null}
                {api.request ? <BidiText text={api.request} className="block text-[11px] text-muted-foreground" /> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {u.states?.length || u.transitions?.length ? (
        <Section title={t("studio.req.states")} count={(u.states?.length ?? 0) + (u.transitions?.length ?? 0)}>
          <div className="flex flex-wrap gap-1.5">
            {u.states?.map((state) => (
              <span key={state.name} className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]" dir="ltr" title={state.meaning}>
                {state.name}
              </span>
            ))}
          </div>
          {u.transitions?.length ? (
            <ul className="mt-2 space-y-1">
              {u.transitions.map((item, index) => (
                <li key={index} className="text-xs">
                  <span className="font-mono" dir="ltr">
                    {item.from} → {item.to}
                  </span>
                  {item.trigger ? <BidiText text={` · ${item.trigger}${item.conditions ? ` (${item.conditions})` : ""}`} className="text-muted-foreground" /> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {u.configurations?.length || u.calculations?.length ? (
        <Section title={t("studio.req.configuration")} count={(u.configurations?.length ?? 0) + (u.calculations?.length ?? 0)}>
          <ul className="space-y-1">
            {u.calculations?.map((item) => (
              <li key={item.name} className="text-xs">
                <span className="font-mono" dir="ltr">
                  {item.formula}
                </span>
                {item.meaning ? <BidiText text={` — ${item.meaning}`} className="text-muted-foreground" /> : null}
              </li>
            ))}
            {u.configurations?.map((item) => (
              <li key={item.key} className="text-xs">
                <span className="font-mono text-primary" dir="ltr">
                  {item.key}
                </span>
                {item.meaning ? <BidiText text={` — ${item.meaning}`} className="text-muted-foreground" /> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {u.flows?.length ? (
        <Section title={t("studio.req.flows")} count={u.flows.length}>
          {u.flows.map((flow) => (
            <div key={flow.name} className="mb-2 space-y-0.5">
              <BidiText text={flow.name} className="block text-xs font-medium" />
              <ol className="list-decimal space-y-0.5 ps-5 text-xs text-muted-foreground">
                {flow.steps?.map((step, index) => (
                  <li key={index}>
                    <BidiText text={step} />
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </Section>
      ) : null}

      {u.entities?.length ? (
        <Section title={t("studio.req.entities")} count={u.entities.length}>
          {u.entities.map((entity) => (
            <div key={entity.name} className="mb-2">
              <div className="font-mono text-xs font-medium" dir="ltr">
                {entity.name}
              </div>
              {entity.description ? <BidiText text={entity.description} className="block text-xs text-muted-foreground" /> : null}
              {entity.fields?.length ? (
                <div className="mt-1 flex flex-wrap gap-1" dir="ltr">
                  {entity.fields.map((fieldItem) => (
                    <span key={fieldItem.name} className="rounded bg-muted px-1.5 font-mono text-[10px]" title={fieldItem.notes}>
                      {fieldItem.name}
                      {fieldItem.type ? <span className="text-muted-foreground">:{fieldItem.type}</span> : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </Section>
      ) : null}

      {u.assumptions?.length || u.outOfScope?.length ? (
        <Section title={t("studio.req.assumptions")} count={(u.assumptions?.length ?? 0) + (u.outOfScope?.length ?? 0)}>
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted-foreground">
            {u.assumptions?.map((item) => (
              <li key={item}>
                <BidiText text={item} />
              </li>
            ))}
            {u.outOfScope?.map((item) => (
              <li key={item}>
                <BidiText text={`${t("studio.req.outOfScope")}: ${item}`} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("studio.req.gaps")}</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableList items={analysis.gaps} addLabel={t("studio.add")} emptyLabel={t("studio.req.noGaps")} onSave={(gaps) => onSave({ gaps })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("studio.req.ambiguities")}</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableList items={analysis.ambiguities} addLabel={t("studio.add")} emptyLabel={t("studio.req.noAmbiguities")} onSave={(ambiguities) => onSave({ ambiguities })} />
          </CardContent>
        </Card>
        {(["questionsProduct", "questionsDeveloper", "questionsBusiness"] as const).map((field) => (
          <Card key={field}>
            <CardHeader>
              <CardTitle>
                {t(`studio.req.${field}`)} <span className="font-normal">({n(analysis[field].length)})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <EditableList items={analysis[field]} addLabel={t("studio.add")} onSave={(items) => onSave({ [field]: items })} />
              {analysis[field].some((question) => reasonOf(question)) ? (
                <details className="text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer">{t("studio.req.why")}</summary>
                  <ul className="mt-1 space-y-1">
                    {analysis[field].map((question) =>
                      reasonOf(question) ? (
                        <li key={question}>
                          <BidiText text={`${question} — ${reasonOf(question)}`} />
                        </li>
                      ) : null,
                    )}
                  </ul>
                </details>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
