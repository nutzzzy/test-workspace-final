"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { api } from "@/lib/api";
import { BidiText } from "@/components/bidi-text";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

type Explanation = { wouldGenerate: number; reasons: string[]; suggestions: string[] };

/**
 * Shown instead of an empty edge-case list: either nothing was generated yet,
 * or the specific reasons this requirement yields no edge cases.
 */
export function EdgeCasesEmpty({ issueId, generated, refreshKey }: { issueId: string; generated: boolean; refreshKey: string }) {
  const { t, n, locale } = useI18n();
  const [data, setData] = useState<Explanation | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!generated) return;
    let alive = true;
    api<Explanation>(`/analysis/${issueId}/edge-cases/explanation?locale=${locale}`)
      .then((result) => {
        if (alive) {
          setData(result);
          setFailed(false);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [issueId, locale, generated, refreshKey]);

  if (!generated) {
    return <p className="text-sm text-muted-foreground">{t("edgeEmpty.notGenerated")}</p>;
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Info className="h-4 w-4 text-primary" />
          {t("edgeEmpty.title")}
        </h3>
        {failed ? <p className="text-xs text-muted-foreground">{t("edgeEmpty.unavailable")}</p> : null}
        {data && data.wouldGenerate > 0 ? (
          <p className="text-xs text-warning">{t("edgeEmpty.stale", { count: n(data.wouldGenerate) })}</p>
        ) : null}
        {data && data.wouldGenerate === 0 ? (
          <>
            <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
              {data.reasons.map((reason) => (
                <li key={reason}>
                  <BidiText text={reason} />
                </li>
              ))}
            </ul>
            {data.suggestions.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("edgeEmpty.howTo")}</p>
                <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                  {data.suggestions.map((item) => (
                    <li key={item}>
                      <BidiText text={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
