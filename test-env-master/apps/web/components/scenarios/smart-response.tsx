"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Analysis = {
  status: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  contentType: string | null;
  importantFields: Array<{ path: string; label: string; preview: string; masked: boolean }>;
  candidateOutputs: Array<{ path: string; name: string; preview: string }>;
  arraySummaries: Array<{ path: string; length: number; fields: string[]; previewCount: number }>;
  errorInformation: { message: string; code: string | null } | null;
  warnings: string[];
};

export function SmartResponse({
  analysis,
  raw,
  labels,
  formatNumber,
}: {
  analysis: Analysis | null;
  raw: unknown;
  labels: {
    smart: string;
    raw: string;
    important: string;
    outputs: string;
  };
  formatNumber: (value: number) => string;
}) {
  const [mode, setMode] = useState<"smart" | "raw">("smart");
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <Button size="sm" variant={mode === "smart" ? "default" : "outline"} onClick={() => setMode("smart")}>
          {labels.smart}
        </Button>
        <Button size="sm" variant={mode === "raw" ? "default" : "outline"} onClick={() => setMode("raw")}>
          {labels.raw}
        </Button>
      </div>
      {mode === "raw" ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2 font-mono text-[10px] dir-ltr">
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : (
        <div className="space-y-2 text-xs">
          {analysis ? (
            <div className="flex flex-wrap gap-2 font-mono text-[11px] dir-ltr">
              {analysis.status != null ? <span>{formatNumber(analysis.status)}</span> : null}
              {analysis.durationMs != null ? <span>{formatNumber(analysis.durationMs)} ms</span> : null}
              {analysis.sizeBytes != null ? <span>{formatNumber(analysis.sizeBytes)} B</span> : null}
              {analysis.contentType ? <span>{analysis.contentType}</span> : null}
            </div>
          ) : null}
          {analysis?.errorInformation ? (
            <p className="text-destructive">
              {analysis.errorInformation.message}
              {analysis.errorInformation.code ? ` · ${analysis.errorInformation.code}` : ""}
            </p>
          ) : null}
          {analysis?.importantFields.length ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{labels.important}</div>
              <dl className="mt-1 grid gap-1 sm:grid-cols-2">
                {analysis.importantFields.map((field) => (
                  <div key={field.path} className="flex justify-between gap-2 rounded border border-border px-2 py-1">
                    <dt className="font-mono text-[10px] text-muted-foreground dir-ltr">{field.label}</dt>
                    <dd className="truncate font-mono text-[11px] dir-ltr">{field.preview}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {analysis?.candidateOutputs.length ? (
            <div className="font-mono text-[10px] text-primary dir-ltr">
              {labels.outputs}: {analysis.candidateOutputs.map((item) => item.name).join(" · ")}
            </div>
          ) : null}
          {analysis?.arraySummaries.map((item) => (
            <p key={item.path} className="font-mono text-[10px] text-muted-foreground dir-ltr">
              {item.path} [{formatNumber(item.length)}] {item.fields.join(", ")}
            </p>
          ))}
          {analysis?.warnings.map((warning) => (
            <p key={warning} className="text-[11px] text-muted-foreground">{warning}</p>
          ))}
        </div>
      )}
    </div>
  );
}
