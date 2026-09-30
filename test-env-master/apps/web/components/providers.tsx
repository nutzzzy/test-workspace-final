"use client";

import { LocaleProvider } from "@/lib/i18n";
import { AppShell } from "@/components/layout/app-shell";
import { ToastProvider } from "@/components/ui/toast";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider>
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </LocaleProvider>
  );
}
