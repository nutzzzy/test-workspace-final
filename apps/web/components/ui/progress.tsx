"use client";

import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type ProgressBarProps = {
  value: number;
  label?: string;
  className?: string;
  size?: "sm" | "md";
};

/** Compact Grafana-style progress with percent label. */
export function ProgressBar({
  value,
  label,
  className,
  size = "md",
}: ProgressBarProps) {
  const { n } = useI18n();
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{label ?? ""}</span>
        <span className="shrink-0 font-mono text-primary">{n(clamped)}%</span>
      </div>
      <div
        className={cn(
          "overflow-hidden rounded-sm border border-border bg-muted",
          size === "sm" ? "h-1.5" : "h-2",
        )}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

type ProgressBannerProps = {
  active: boolean;
  value: number;
  label: string;
  error?: string | null;
  success?: string | null;
};

export function ProgressBanner({
  active,
  value,
  label,
  error,
  success,
}: ProgressBannerProps) {
  const { err } = useI18n();
  if (!active && !error && !success) return null;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        error
          ? "border-destructive/40 bg-destructive/10"
          : success
            ? "border-success/40 bg-success/10"
            : "border-primary/30 bg-primary/5",
      )}
    >
      {active ? <ProgressBar value={value} label={label} /> : null}
      {error ? (
        <p className="text-xs text-destructive">{err(error)}</p>
      ) : null}
      {!active && success ? (
        <p className="text-xs text-success">{success}</p>
      ) : null}
    </div>
  );
}
