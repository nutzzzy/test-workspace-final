"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  icon?: React.ReactNode;
};

/** Overflow menu: opens on click, arrow keys move between items, Escape or an outside click closes it. */
export function Menu({ label, items, trigger }: { label: string; items: MenuItem[]; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = root.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])");
    first?.focus();
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const list = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
    next?.focus();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {trigger ?? <MoreHorizontal className="h-4 w-4" />}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={move}
          className="absolute end-0 top-8 z-30 min-w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-40",
                item.destructive ? "text-destructive" : "text-foreground",
              )}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
