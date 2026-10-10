"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Plus, Trash2, Upload } from "lucide-react";
import { BidiText, textDirection } from "@/components/bidi-text";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconAction } from "@/components/workspace/editable";
import { api, uploadFile } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

type DocumentRow = { id: string; title: string; fileName: string | null; kind: string; sizeBytes: number; length: number; text: string; createdAt: string };

/**
 * PRDs and other business documents of an issue. Their text is read by the
 * analysis alongside the issue, so business logic that only the PRD
 * describes is analysed too.
 */
export function DocumentsPanel({ issueId, onChange }: { issueId: string; onChange: () => void }) {
  const { t, n, d, err } = useI18n();
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDocs(await api<DocumentRow[]>(`/analysis/${issueId}/documents`));
  }, [issueId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      onChange();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-border bg-card p-3" aria-labelledby="documents-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="documents-title" className="flex items-center gap-1.5 text-sm font-medium">
          <FileText className="h-4 w-4 text-primary" />
          {t("studio.documents.title")}
        </h2>
        <span className="text-[11px] text-muted-foreground">{t("studio.documents.optional")}</span>
        <div className="ms-auto flex gap-1.5">
          <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent focus-within:ring-1 focus-within:ring-ring">
            <Upload className="h-3.5 w-3.5" />
            {t("studio.documents.upload")}
            <input
              type="file"
              className="sr-only"
              accept=".md,.markdown,.txt,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void run(() => uploadFile(`/analysis/${issueId}/documents/upload`, file, { kind: "PRD" }));
              }}
            />
          </label>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t("studio.documents.paste")}
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("studio.documents.hint")}</p>
      {docs.length > 0 ? (
        <ul className="space-y-1">
          {docs.map((doc) => (
            <li key={doc.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
              <button type="button" className="min-w-0 flex-1 text-start hover:underline" onClick={() => void api<DocumentRow>(`/analysis/documents/${doc.id}`).then((full) => setPreview({ title: full.title, text: full.text }))}>
                <BidiText text={doc.title} className="font-medium" />
                <span className="ms-2 text-muted-foreground">
                  {doc.fileName ? `${doc.fileName} · ` : ""}
                  {t("studio.documents.size", { count: n(doc.length) })} · {d(doc.createdAt)}
                </span>
              </button>
              <IconAction
                label={t("studio.delete")}
                danger
                onClick={() => {
                  if (window.confirm(t("common.confirmDelete", { name: doc.title }))) void run(() => api(`/analysis/documents/${doc.id}`, { method: "DELETE" }));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconAction>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-xs text-destructive">{err(error)}</p> : null}

      <Dialog
        open={adding}
        title={t("studio.documents.pasteTitle")}
        description={t("studio.documents.pasteHint")}
        closeLabel={t("studio.cancel")}
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setAdding(false)}>
              {t("studio.cancel")}
            </Button>
            <Button
              disabled={busy || !text.trim()}
              onClick={() =>
                void run(() => api(`/analysis/${issueId}/documents`, { method: "POST", body: JSON.stringify({ title, text, kind: "PRD" }) })).then((ok) => {
                  if (!ok) return;
                  setTitle("");
                  setText("");
                  setAdding(false);
                })
              }
            >
              {t("studio.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <input
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
            placeholder={t("studio.documents.docTitle")}
            value={title}
            dir={textDirection(title)}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            data-autofocus
            className="min-h-72 w-full rounded-md border border-border bg-background p-2 text-sm leading-6"
            dir={textDirection(text.slice(0, 400))}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </Dialog>

      <Dialog open={Boolean(preview)} title={preview?.title ?? ""} closeLabel={t("studio.cancel")} onClose={() => setPreview(null)} className="max-w-3xl">
        <BidiText text={preview?.text ?? ""} className="text-sm leading-6" />
      </Dialog>
    </section>
  );
}
