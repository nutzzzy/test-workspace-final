import { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * Text that mixes Persian and English (requirements, generated test cases).
 * Direction is decided per line by the dominant script — not by whether one
 * Persian character appears somewhere — so an English sentence stays LTR in a
 * Persian page and the reverse. Lines that are code, JSON or an API call are
 * always LTR; inside an RTL line, technical tokens (endpoints, identifiers,
 * keys, formulas) are isolated so they keep their own order.
 */

const PERSIAN = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-z]/g;
/** Lines that are code, payloads, API calls or table rows of identifiers. */
const CODE_LINE = /^\s*(?:[{}[\]"`]|(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/|\/[\w{}.-]+\/|[A-Za-z_][\w.]*\s*(?:=|\+\+|:\s*["{[\d])|SELECT\b|INSERT\b|UPDATE\b|DELETE\b)/;
/** Technical tokens inside prose: API calls, paths, keys (AC-01), snake/camel identifiers, `code`, formulas. */
const TOKEN =
  /(`[^`]+`|(?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s،,]+|\/[A-Za-z0-9_./{}:-]+|\b[A-Z][A-Z0-9]*-\d+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z_][\w.]*\s*=\s*[^\s،]+|\{\{[^}]*\}\})/g;

export function textDirection(text: string): "rtl" | "ltr" {
  if (CODE_LINE.test(text)) return "ltr";
  const persian = text.match(PERSIAN)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (persian === 0) return "ltr";
  if (latin === 0) return "rtl";
  // Persian grammar with English terms is still a Persian sentence.
  return persian >= latin * 0.4 ? "rtl" : "ltr";
}

function Line({ text, className }: { text: string; className?: string }) {
  const dir = textDirection(text);
  const code = dir === "ltr" && CODE_LINE.test(text);
  if (dir === "ltr") {
    return (
      <span dir="ltr" className={cn(code && "font-mono text-[0.92em]", className)} style={{ textAlign: "left", unicodeBidi: "isolate" }}>
        {text}
      </span>
    );
  }
  const parts = text.split(TOKEN);
  return (
    <span dir="rtl" className={className} style={{ textAlign: "right", unicodeBidi: "isolate" }}>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <bdi key={index} dir="ltr" className="font-mono text-[0.92em]">
            {part.replace(/^`|`$/g, "")}
          </bdi>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </span>
  );
}

export function BidiText({ text, className }: { text: string; className?: string }) {
  const value = text ?? "";
  if (!value.includes("\n")) return <Line text={value} className={className} />;
  // Multi-line text: every line gets its own direction.
  const lines = value.split("\n");
  return (
    <span className={cn("block", className)}>
      {lines.map((line, index) =>
        line.trim() ? <Line key={index} text={line} className="block" /> : <span key={index} className="block h-2" aria-hidden />,
      )}
    </span>
  );
}
