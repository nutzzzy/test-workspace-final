"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

export function PlaceholderPage({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase?: string;
}) {
  const { t } = useI18n();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <Badge className="border-primary/30 bg-primary/10 text-primary">
          {phase ?? t("app.phaseFooter")}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("app.comingSoon")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("app.comingSoonBody")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
