"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

type Issue = { id: string; key: string; title: string };

export default function WorkspaceIndexPage() {
  const { t } = useI18n();
  const [issues, setIssues] = useState<Issue[]>([]);

  useEffect(() => {
    api<Issue[]>("/jira/issues").then(setIssues).catch(() => setIssues([]));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{t("workspace.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("workspace.subtitle")}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("workspace.issues")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {issues.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("workspace.empty")}</p>
          ) : (
            issues.map((issue) => (
              <Link
                key={issue.id}
                href={`/workspace/${issue.key}`}
                className="block rounded border border-border px-2.5 py-2 text-sm hover:bg-accent"
              >
                <span className="font-mono text-xs text-primary dir-ltr inline-block">
                  {issue.key}
                </span>
                <span className="ms-2">{issue.title}</span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
