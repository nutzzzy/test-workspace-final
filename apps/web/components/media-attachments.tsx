"use client";

import { API_BASE } from "@/lib/api";

export type MediaItem = {
  id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime";

export function MediaPicker({
  label,
  hint,
  disabled,
  onFiles,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <label className="block space-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <input
        type="file"
        accept={ACCEPT}
        multiple
        disabled={disabled}
        className="block w-full text-xs file:me-2 file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-1 file:text-xs file:text-foreground"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      {hint ? <span className="block text-[10px]">{hint}</span> : null}
    </label>
  );
}

export function MediaGallery({
  items,
  onRemove,
  removeLabel,
}: {
  items: MediaItem[];
  onRemove?: (id: string) => void;
  removeLabel: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((item) => {
        const src = `${API_BASE}/attachments/${item.id}/file`;
        const video = item.mimeType.startsWith("video/");
        return (
          <figure key={item.id} className="space-y-1 rounded border border-border p-1">
            {video ? (
              <video controls preload="metadata" className="max-h-40 w-full bg-black" src={src} />
            ) : (
              <img alt={item.filename} className="max-h-40 w-full object-contain" src={src} />
            )}
            <figcaption className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[10px] text-muted-foreground dir-ltr">{item.filename}</span>
              {onRemove ? (
                <button
                  type="button"
                  className="shrink-0 text-[10px] text-destructive"
                  onClick={() => onRemove(item.id)}
                >
                  {removeLabel}
                </button>
              ) : null}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
