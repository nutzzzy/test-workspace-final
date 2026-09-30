export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new Error("Network request failed");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(readError(text, response.status));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function uploadFile<T>(
  path: string,
  file: File,
  fields: Record<string, string>,
): Promise<T> {
  const body = new FormData();
  body.append("file", file);
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      body,
      cache: "no-store",
    });
  } catch {
    throw new Error("Network request failed");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(readError(text, response.status));
  }
  return response.json() as Promise<T>;
}

function readError(text: string, status: number): string {
  if (status === 401 || status === 403) {
    return "You do not have permission to perform this action.";
  }
  const trimmed = text.trim();
  if (!trimmed) return status >= 500 ? "Unexpected error" : "Request failed";
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (Array.isArray(parsed.message)) {
      const joined = parsed.message.filter((item) => typeof item === "string").join(" ");
      if (joined) return joined;
    }
  } catch {
    // plain text body
  }
  if (trimmed.startsWith("<") || trimmed.length > 240 || status >= 500) {
    return "Unexpected error";
  }
  return trimmed;
}
