export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

export function mediaExtension(mimeType: string): string | null {
  return EXTENSIONS[mimeType] ?? null;
}

export function assertMedia(mimeType: string, sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_MEDIA_BYTES) {
    throw new Error("File is too large");
  }
  const extension = mediaExtension(mimeType);
  if (!extension) throw new Error("Only image and video files are accepted");
  return extension;
}

export function parseOwnerIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const ids = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length > 50) throw new Error("Invalid attachment owner");
  if (ids.some((id) => !/^[a-zA-Z0-9_-]{8,64}$/.test(id))) {
    throw new Error("Invalid attachment owner");
  }
  return ids;
}

export function displayName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() ?? "";
  const cleaned = base.replace(/[^\w.\-\u0600-\u06FF ]+/g, "").slice(0, 180).trim();
  return cleaned || "file";
}
