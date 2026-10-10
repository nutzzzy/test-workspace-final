"use client";

import type { ComponentType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bug,
  FlaskConical,
  LayoutDashboard,
  Layers3,
  PlayCircle,
  Settings,
  SquareKanban,
  Ticket,
  Workflow,
  X,
} from "lucide-react";
import { APP_NAV_ITEMS } from "@qa-workbench/shared";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  jira: Ticket,
  workspace: SquareKanban,
  suites: Layers3,
  scenarios: Workflow,
  runs: PlayCircle,
  bugs: Bug,
  environments: FlaskConical,
  settings: Settings,
};

const NAV_KEYS: Record<string, string> = {
  "/": "nav.dashboard",
  "/jira": "nav.jira",
  "/workspace": "nav.workspace",
  "/suites": "nav.suites",
  "/scenarios": "nav.scenarios",
  "/runs": "nav.runs",
  "/bugs": "nav.bugs",
  "/environments": "nav.environments",
  "/settings": "nav.settings",
};

function KiwiMark({ className = "h-4 w-4 shrink-0" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M12.2 3.2c1.7-.2 3.4.7 4.2 2.1-1.8.2-3.2 1-4.1 2-.7-1.2-2-2-3.6-2.2 1-.9 2.3-1.7 3.5-1.9z"
        fill="#8fd15a"
      />
      <circle cx="12" cy="14" r="7" fill="#6b7a3a" />
      <circle cx="12" cy="14" r="5.35" fill="#d5e38a" />
      <circle cx="12" cy="14" r="2.05" fill="#f6f3e8" />
      <circle cx="12" cy="10.55" r="0.48" fill="#3c3428" />
      <circle cx="14.7" cy="12.15" r="0.48" fill="#3c3428" />
      <circle cx="14.15" cy="15.55" r="0.48" fill="#3c3428" />
      <circle cx="9.85" cy="15.55" r="0.48" fill="#3c3428" />
      <circle cx="9.3" cy="12.15" r="0.48" fill="#3c3428" />
    </svg>
  );
}

export function AppSidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label={t("nav.closeMenu")}
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={onClose}
        />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 h-full w-64 max-w-[85vw] flex-col border-e border-sidebar-border bg-sidebar md:static md:z-auto md:flex md:w-56 md:max-w-none",
          open ? "flex" : "max-md:hidden",
        )}
      >
      <div className="flex h-12 items-center gap-2 border-b border-sidebar-border px-3">
        <KiwiMark className="h-6 w-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight text-foreground">
            {t("app.name")}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {t("app.tagline")}
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          aria-label={t("nav.closeMenu")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {APP_NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.icon] ?? LayoutDashboard;
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const label = t(NAV_KEYS[item.href] ?? item.label);

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  active
                    ? "text-primary"
                    : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              <span className="truncate">{label}</span>
              {active ? (
                <span className="ms-auto h-1 w-1 rounded-full bg-primary" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border px-3 py-2.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <KiwiMark />
          <span className="dir-ltr tracking-wide">powered by kiwi</span>
        </div>
      </div>
    </aside>
    </>
  );
}
