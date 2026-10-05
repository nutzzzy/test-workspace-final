"use client";

import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { BidiText, textDirection } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-6";

/** Icon button that only shows its label to screen readers. */
export function IconAction({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** A text that can be corrected in place; saving teaches the analysis. */
export function EditableText({
  value,
  onSave,
  multiline = true,
  className,
  placeholder,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div className="group flex items-start gap-1">
        <BidiText text={value || placeholder || ""} className={cn("min-w-0 flex-1 whitespace-pre-wrap", !value && "text-muted-foreground", className)} />
        <span className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
          <IconAction
            label={t("studio.edit")}
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconAction>
        </span>
      </div>
    );
  }
  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5">
      {multiline ? (
        <textarea
          autoFocus
          dir={textDirection(draft)}
          className={cn(field, "min-h-24")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <input
          autoFocus
          dir={textDirection(draft)}
          className={cn(field, "h-8 py-0")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      )}
      <div className="flex gap-1.5">
        <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void save()}>
          <Check className="h-3.5 w-3.5" />
          {t("studio.save")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
          <X className="h-3.5 w-3.5" />
          {t("studio.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** A list where every item can be edited or removed, and new items added. */
export function EditableList({
  items,
  onSave,
  addLabel,
  emptyLabel,
}: {
  items: string[];
  onSave: (next: string[]) => Promise<void>;
  addLabel: string;
  emptyLabel?: string;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const replace = (index: number, next: string) => onSave(items.map((item, i) => (i === index ? next : item)).filter(Boolean));

  return (
    <div className="space-y-1.5">
      {items.length === 0 && emptyLabel ? <p className="text-xs text-muted-foreground">{emptyLabel}</p> : null}
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={`${index}-${item.slice(0, 20)}`} className="group flex items-start gap-1 rounded-md px-1 py-0.5 hover:bg-accent/40">
            <div className="min-w-0 flex-1">
              <EditableText value={item} onSave={(next) => replace(index, next)} className="text-sm" />
            </div>
            <span className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
              <IconAction label={t("studio.delete")} danger onClick={() => void onSave(items.filter((_, i) => i !== index))}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconAction>
            </span>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="space-y-1.5">
          <textarea autoFocus dir={textDirection(draft)} className={cn(field, "min-h-16")} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={!draft.trim()}
              onClick={() =>
                void onSave([...items, draft.trim()]).then(() => {
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
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}
