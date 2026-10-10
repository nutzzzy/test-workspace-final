"use client";

import type { IstqbTechnique, ProviderEvaluation, QualityLevel, QualityNote, QualityReport as Report } from "@qa-workbench/shared";
import { Gauge } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const LEVEL_KEY: Record<QualityLevel, string> = {
  Excellent: "excellent",
  "Very Good": "veryGood",
  Good: "good",
  "Needs Improvement": "needsImprovement",
  Poor: "poor",
};
const TECHNIQUE_KEY: Record<IstqbTechnique, string> = {
  "Equivalence Partitioning": "ep",
  "Boundary Value Analysis": "bva",
  "Decision Table Testing": "dt",
  "State Transition Testing": "st",
  "Use Case Testing": "uc",
  "Error Guessing": "eg",
  "Exploratory Testing": "ex",
  "Risk-based Testing": "rb",
};
const TIMING_KEYS = ["taskParsingMs", "requirementExtractionMs", "normalizationMs", "scoringMs", "deduplicationMs", "selectionMs", "qualityGateMs", "totalMs"] as const;

function levelTone(level: QualityLevel) {
  if (level === "Excellent" || level === "Very Good") return "text-success";
  if (level === "Good") return "text-primary";
  if (level === "Needs Improvement") return "text-warning";
  return "text-destructive";
}

/**
 * The provider comparison of a run and the final, quality-gated test set.
 * Everything shown here is computed by the API; this only words it.
 */
export function QualityReport({ report, running }: { report: Report; running: boolean }) {
  const { t, n, locale } = useI18n();
  const sep = locale === "fa" ? "، " : ", ";
  const pct = (value: number | null) => (value === null ? t("quality.na") : `${n(value)}%`);
  const seconds = (ms: number) => `${n(Math.round(ms / 100) / 10)}s`;
  /** A reason code with its values, the dimension and status values worded too. */
  const note = (item: QualityNote, group: string) => {
    const values = Object.fromEntries(
      Object.entries(item.values ?? {}).map(([key, value]) => [
        key,
        key === "dimension" ? t(`quality.dimensions.${value}`) : key === "status" && group === "reasons" ? t(`quality.status.${value}`) : typeof value === "number" ? n(value) : value,
      ]),
    );
    if (item.code.startsWith("improve.")) return t("quality.recommend", { dimension: t(`quality.dimensions.${item.code.slice(8)}`) });
    return t(`quality.${group}.${item.code}`, values);
  };
  const final = report.final;
  const comparing = report.providers.length > 1;

  return (
    <section className="space-y-2 rounded-md border border-border p-2" aria-labelledby="quality-title">
      <h3 id="quality-title" className="flex items-center gap-1.5 text-xs font-medium">
        <Gauge className="h-3.5 w-3.5 text-primary" />
        {t("quality.title")}
        {running && !final ? <span className="font-normal text-muted-foreground">· {t("quality.live")}</span> : null}
      </h3>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[11px]">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border text-start">
              {["provider", "score", "coverage", "istqb", "risk", "negative", "duplicates", "time", "status"].map((key) => (
                <th key={key} scope="col" className="px-1.5 py-1 text-start font-medium">
                  {t(`quality.columns.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.providers.map((item: ProviderEvaluation) => {
              const done = item.status !== "running" && item.caseCount > 0;
              return (
                <tr key={item.provider} className={cn("border-b border-border/50", report.selection.base === item.name && "bg-primary/5")}>
                  <td className="px-1.5 py-1">
                    <span className="font-medium">{item.name}</span> <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">{item.model}</span>
                  </td>
                  <td className="px-1.5 py-1">
                    {done ? (
                      <span className={levelTone(item.qualityLevel)} title={t(`quality.levels.${LEVEL_KEY[item.qualityLevel]}`)}>
                        {n(item.overallScore)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-1.5 py-1">{done ? pct(item.requirementCoverage) : "—"}</td>
                  <td className="px-1.5 py-1">{done ? pct(item.istqbCoverage) : "—"}</td>
                  <td className="px-1.5 py-1">{done ? pct(item.riskCoverage) : "—"}</td>
                  <td className="px-1.5 py-1">{done ? pct(item.negativeCoverage) : "—"}</td>
                  <td className="px-1.5 py-1">{done ? n(item.duplicateCount) : "—"}</td>
                  <td className="px-1.5 py-1">{item.status === "running" ? "…" : seconds(item.processingMs)}</td>
                  <td className="px-1.5 py-1">
                    <span
                      className={cn(
                        item.status === "ok" && "text-success",
                        (item.status === "partial" || item.status === "timeout") && "text-warning",
                        item.status === "failed" && "text-destructive",
                        item.status === "running" && "text-muted-foreground",
                      )}
                      title={item.error}
                    >
                      {t(`quality.status.${item.status}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {final ? (
        <div className="space-y-1.5 rounded-md bg-muted/40 p-2 text-[11px]">
          <p className="text-xs font-medium">
            {t(comparing ? "quality.finalMerged" : "quality.finalSingle")}:{" "}
            <span className={levelTone(final.qualityLevel)}>
              {n(final.overallScore)} · {t(`quality.levels.${LEVEL_KEY[final.qualityLevel]}`)}
            </span>
          </p>
          <p className="text-muted-foreground">
            {t("quality.finalSummary", {
              count: n(final.caseCount),
              coverage: n(final.requirementCoverage),
              istqb: pct(final.istqbCoverage),
              risk: pct(final.riskCoverage),
              negative: pct(final.negativeCoverage),
            })}
          </p>
          {report.selection.reasons.length ? (
            <div>
              <p className="font-medium">{t("quality.why")}</p>
              <ul className="list-disc space-y-0.5 ps-4">
                {report.selection.reasons.map((reason, index) => (
                  <li key={`${reason.code}-${index}`}>{note(reason, "reasons")}</li>
                ))}
                {final.improved > 0 ? <li>{t("quality.improved", { count: n(final.improved) })}</li> : null}
              </ul>
            </div>
          ) : null}
          {final.untracedRequirements.length ? (
            <p className="text-warning">{t("quality.untraced", { keys: final.untracedRequirements.join(sep) })}</p>
          ) : null}
          {final.missingScenarios.length ? (
            <details>
              <summary className="cursor-pointer font-medium">{t("quality.missing", { count: n(final.missingScenarios.length) })}</summary>
              <ul className="list-disc space-y-0.5 ps-4 text-muted-foreground">
                {final.missingScenarios.map((item, index) => (
                  <li key={`${item.code}-${index}`}>{note(item, "missingCodes")}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {final.rejected.length ? (
            <details>
              <summary className="cursor-pointer font-medium">{t("quality.rejected", { count: n(final.rejected.length) })}</summary>
              <ul className="list-disc space-y-0.5 ps-4 text-muted-foreground">
                {final.rejected.map((item, index) => (
                  <li key={`${item.title}-${index}`}>
                    {item.title} — {item.reasons.map((reason) => t(`quality.findings.${reason}`)).join(sep)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {report.providers.some((item) => item.strengths.length || item.weaknesses.length) ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer font-medium">{t("quality.perProvider")}</summary>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {report.providers
              .filter((item) => item.caseCount > 0)
              .map((item) => (
                <div key={item.provider} className="rounded border border-border p-1.5">
                  <p className="font-medium">{item.name}</p>
                  {item.strengths.length ? <p className="text-success">+ {item.strengths.map((s) => note(s, "notes")).join(" · ")}</p> : null}
                  {item.weaknesses.length ? <p className="text-warning">− {item.weaknesses.map((s) => note(s, "notes")).join(" · ")}</p> : null}
                  {item.recommendations.length ? <p className="text-muted-foreground">→ {item.recommendations.map((s) => note(s, "notes")).join(" · ")}</p> : null}
                </div>
              ))}
          </div>
        </details>
      ) : null}

      {/* Diagnostics: how the score was weighted and where the time went. */}
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">{t("quality.diagnostics")}</summary>
        <div className="mt-1 space-y-1">
          <p>
            {t("quality.applicable")}:{" "}
            {report.applicableTechniques.length
              ? report.applicableTechniques.map((item) => `${t(`quality.techniques.${TECHNIQUE_KEY[item.technique]}`)} (${t(`quality.techniqueReasons.${item.reason}`)})`).join(" · ")
              : t("quality.none")}
          </p>
          {report.emphasis.length ? <p>{t("quality.emphasis", { kinds: report.emphasis.map((kind) => t(`quality.kinds.${kind}`)).join(sep) })}</p> : null}
          <p>
            {t("quality.weights")}:{" "}
            {Object.entries(report.weights)
              .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
              .map(([dimension, weight]) => `${t(`quality.dimensions.${dimension}`)} ${n(Math.round((weight ?? 0) * 10) / 10)}`)
              .join(" · ")}
          </p>
          <p dir="ltr" className="font-mono text-[10px]">
            {[
              ...TIMING_KEYS.map((key) => `${key}=${report.timing[key]}`),
              ...Object.entries(report.timing.providers).map(([name, ms]) => `${name}=${ms}`),
            ].join("  ")}
          </p>
        </div>
      </details>
    </section>
  );
}
