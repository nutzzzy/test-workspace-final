"use client";

import { useState } from "react";

/** JSONPath of a child: dot notation, or ['key'] for keys a dot path cannot express. */
function childPath(path: string, key: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${path}.${key}` : `${path}['${key.replace(/(['\\])/g, "\\$1")}']`;
}

export function JsonTree({
  value,
  path = "$",
  onExtract,
  onAssert,
  extractLabel,
  assertLabel,
}: {
  value: unknown;
  path?: string;
  onExtract?: (path: string, value: unknown) => void;
  onAssert?: (path: string, value: unknown) => void;
  extractLabel: string;
  assertLabel: string;
}) {
  const [open, setOpen] = useState(path.split(".").length < 3);
  if (value && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.slice(0, open ? value.length : 0).map((item, index) => [String(index), item] as const)
      : Object.entries(value as Record<string, unknown>);
    const preview = Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
    return (
      <div className="ps-2 font-mono text-[11px] dir-ltr">
        <button type="button" className="text-muted-foreground" onClick={() => setOpen((current) => !current)}>
          {open ? "▾" : "▸"} {path} {preview}
        </button>
        {open
          ? (Array.isArray(value) ? value.slice(0, 30) : entries).map((entry, index) => {
              const [key, child] = Array.isArray(value)
                ? [String(index), entry]
                : (entry as readonly [string, unknown]);
              const next = Array.isArray(value) ? `${path}[${key}]` : childPath(path, key);
              return (
                <JsonTree
                  key={next}
                  value={child}
                  path={next}
                  onExtract={onExtract}
                  onAssert={onAssert}
                  extractLabel={extractLabel}
                  assertLabel={assertLabel}
                />
              );
            })
          : null}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 ps-2 font-mono text-[11px] dir-ltr">
      <span className="text-muted-foreground">{path}</span>
      <span>{String(value)}</span>
      {onExtract ? (
        <button type="button" className="text-[10px] text-primary" onClick={() => onExtract(path, value)}>
          {extractLabel}
        </button>
      ) : null}
      {onAssert ? (
        <button type="button" className="text-[10px] text-primary" onClick={() => onAssert(path, value)}>
          {assertLabel}
        </button>
      ) : null}
    </div>
  );
}
