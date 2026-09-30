"use client";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";

type Source = { stepName: string; orderIndex: number; path: string };
type Candidate = {
  location: string;
  field: string;
  fieldName: string;
  original: string;
  replacement: string;
  source: Source;
  originalSource: Source | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
};
type Attempt = { candidate: Candidate; status: number | null; expectationMet: boolean; failures: string[] };
type Trace = {
  outcome: string;
  originalStatus: number | null;
  failures: string[];
  attempts: Attempt[];
  suggestions: Candidate[];
  blockedReason?: string;
  maxAttempts: number;
};
type Consumed = { variable: string; location: string };

function readFlow(output: unknown): { recovery: Trace | null; consumed: Consumed[] } {
  if (!output || typeof output !== "object" || Array.isArray(output)) return { recovery: null, consumed: [] };
  const record = output as { recovery?: unknown; consumedVars?: unknown };
  const recovery =
    record.recovery && typeof record.recovery === "object" && "outcome" in record.recovery
      ? (record.recovery as Trace)
      : null;
  const consumed = Array.isArray(record.consumedVars)
    ? record.consumedVars.filter(
        (item): item is Consumed =>
          !!item && typeof item === "object" && typeof (item as Consumed).variable === "string",
      )
    : [];
  return { recovery, consumed };
}

/** Variables a step used and produced, then its recovery trace, if any. */
export function FlowTrace({ output, extractedVars }: { output: unknown; extractedVars?: unknown }) {
  const { t, n } = useI18n();
  const { recovery, consumed } = readFlow(output);
  const produced =
    extractedVars && typeof extractedVars === "object" && !Array.isArray(extractedVars)
      ? Object.keys(extractedVars as Record<string, unknown>)
      : [];
  if (!recovery && consumed.length === 0 && produced.length === 0) return null;

  const step = (source: Source) =>
    t("scenarios.flow.stepRef", { n: n(source.orderIndex + 1), name: source.stepName });
  const field = (candidate: Candidate) =>
    candidate.location === "url" ? t("scenarios.flow.urlSegment", { name: candidate.fieldName }) : candidate.field;

  return (
    <div className="space-y-2 text-xs">
      {consumed.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">{t("scenarios.flow.uses")}</span>
          {consumed.map((item) => (
            <Badge key={`${item.variable}|${item.location}`} className="dir-ltr font-mono">
              {`{{${item.variable}}}`} → {item.location}
            </Badge>
          ))}
        </div>
      ) : null}
      {produced.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">{t("scenarios.flow.produces")}</span>
          {produced.map((name) => (
            <Badge key={name} className="dir-ltr border-primary/40 font-mono text-primary">
              {name}
            </Badge>
          ))}
        </div>
      ) : null}

      {recovery ? (
        <div className="space-y-1.5 rounded border border-warning/40 bg-warning/5 px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{t("scenarios.flow.recoveryTitle")}</span>
            <Badge
              className={
                recovery.outcome === "RECOVERED"
                  ? "border-success/40 text-success"
                  : recovery.outcome === "FAILED"
                    ? "border-destructive/40 text-destructive"
                    : undefined
              }
            >
              {t(`scenarios.flow.outcome.${recovery.outcome}`)}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            {t("scenarios.flow.originalStatus", {
              status: recovery.originalStatus === null ? "—" : n(recovery.originalStatus, { useGrouping: false }),
            })}
            {recovery.failures.length ? (
              <span className="dir-ltr ms-1 inline-block font-mono">· {recovery.failures.join(" · ")}</span>
            ) : null}
          </p>

          {recovery.attempts.map((attempt, index) => (
            <div key={index} className="space-y-0.5 border-s-2 border-border ps-2">
              <CandidateLine candidate={attempt.candidate} step={step} field={field} />
              <p>
                {t("scenarios.flow.attempt", {
                  n: n(index + 1),
                  status: attempt.status === null ? "—" : n(attempt.status, { useGrouping: false }),
                })}{" "}
                <span className={attempt.expectationMet ? "text-success" : "text-destructive"}>
                  {attempt.expectationMet ? t("scenarios.flow.expectationMet") : t("scenarios.flow.expectationNotMet")}
                </span>
              </p>
            </div>
          ))}

          {recovery.suggestions.length > 0 ? (
            <div className="space-y-1">
              <p className="text-muted-foreground">{t("scenarios.flow.suggestionsTitle")}</p>
              {recovery.suggestions.map((candidate, index) => (
                <div key={index} className="border-s-2 border-warning/50 ps-2">
                  <CandidateLine candidate={candidate} step={step} field={field} />
                </div>
              ))}
            </div>
          ) : null}
          {recovery.blockedReason ? (
            <p className="text-muted-foreground">
              {t(`scenarios.flow.blocked.${recovery.blockedReason}`, { max: n(recovery.maxAttempts) })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CandidateLine({
  candidate,
  step,
  field,
}: {
  candidate: Candidate;
  step: (source: Source) => string;
  field: (candidate: Candidate) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-0.5">
      <p>
        {t("scenarios.flow.sent")}
        <code className="dir-ltr mx-1 inline-block">{field(candidate)} = {candidate.original}</code>
        {candidate.originalSource ? (
          <span className="text-muted-foreground">
            {t("scenarios.flow.cameFrom", { step: step(candidate.originalSource) })}
            <code className="dir-ltr ms-1 inline-block">{candidate.originalSource.path}</code>
          </span>
        ) : null}
      </p>
      <p>
        {t("scenarios.flow.candidate")}
        <code className="dir-ltr mx-1 inline-block">{field(candidate)} = {candidate.replacement}</code>
        <span className="text-muted-foreground">
          {t("scenarios.flow.from", { step: step(candidate.source) })}
          <code className="dir-ltr ms-1 inline-block">{candidate.source.path}</code>
        </span>{" "}
        <Badge>{t(`scenarios.flow.confidence.${candidate.confidence}`)}</Badge>{" "}
        <span className="text-muted-foreground">{t(`scenarios.flow.reason.${candidate.reason}`)}</span>
      </p>
    </div>
  );
}
