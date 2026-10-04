import { interpolatePath } from "../assert.util";
import type { DependencyLocation, FlowHttpStep } from "./dependency-analyzer";
import { replaceToken } from "./dependency-analyzer";

export type DependencyChange = {
  producerStepId: string;
  consumerStepId: string;
  sourcePath: string;
  variable: string;
  location: DependencyLocation;
  locationDetail: string;
};

export function extractionPath(sourcePath: string): string {
  const cleaned = sourcePath.replace(/^\$\.?/, "");
  return cleaned ? `body.${cleaned}` : "body";
}

export function applyDependency(
  steps: FlowHttpStep[],
  change: DependencyChange,
  body: unknown,
): { steps: FlowHttpStep[]; insertedExtract: boolean } {
  const value = interpolatePath(body, change.sourcePath);
  if (value === undefined || value === null || typeof value === "object") {
    throw new Error("Extraction path has no scalar value");
  }
  const literal = String(value);
  const ordered = [...steps].sort((a, b) => a.orderIndex - b.orderIndex);
  const producerIndex = ordered.findIndex((step) => step.id === change.producerStepId);
  const consumer = ordered.find((step) => step.id === change.consumerStepId);
  if (producerIndex < 0 || !consumer) throw new Error("Dependency steps were not found");

  const path = extractionPath(change.sourcePath);
  const already = ordered.some(
    (step) =>
      step.type === "EXTRACT_VARIABLE" &&
      step.config.variable === change.variable &&
      step.config.path === path,
  );

  const nextConsumer: FlowHttpStep = {
    ...consumer,
    config: patchConfig(consumer.config, change, literal),
  };

  const next = ordered.map((step) => (step.id === consumer.id ? nextConsumer : step));
  if (already) {
    return {
      insertedExtract: false,
      steps: next.map((step, index) => ({ ...step, orderIndex: index })),
    };
  }

  const extract: FlowHttpStep = {
    id: `extract-${change.variable}`,
    name: change.variable,
    type: "EXTRACT_VARIABLE",
    orderIndex: producerIndex + 1,
    config: { variable: change.variable, path },
  };
  next.splice(producerIndex + 1, 0, extract);
  return {
    insertedExtract: true,
    steps: next.map((step, index) => ({ ...step, orderIndex: index })),
  };
}

function patchConfig(
  config: Record<string, unknown>,
  change: DependencyChange,
  literal: string,
): Record<string, unknown> {
  const next = structuredClone(config);
  if ((change.location === "url" || change.location === "path") && typeof next.url === "string") {
    next.url = replaceInUrl(next.url, literal, change.variable, change.location === "path" ? "path" : "all");
  }
  if (change.location === "header") {
    const headers = { ...((next.headers as Record<string, string> | undefined) ?? {}) };
    const key = Object.keys(headers).find(
      (item) => item.toLowerCase() === change.locationDetail.toLowerCase(),
    );
    if (key && typeof headers[key] === "string") {
      headers[key] = replaceToken(headers[key], literal, change.variable);
      next.headers = headers;
    }
  }
  if (change.location === "query") {
    const query = { ...((next.query as Record<string, string> | undefined) ?? {}) };
    if (typeof query[change.locationDetail] === "string") {
      query[change.locationDetail] = replaceToken(query[change.locationDetail], literal, change.variable);
      next.query = query;
    } else if (typeof next.url === "string") {
      // The parameter is written into the URL itself (?bikerId=125).
      next.url = replaceInUrl(next.url, literal, change.variable, "query", change.locationDetail);
    }
  }
  if (change.location === "form" && typeof next.body === "string") {
    next.body = next.body
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0 || decodeSafe(pair.slice(0, eq)) !== change.locationDetail) return pair;
        return `${pair.slice(0, eq)}=${replaceToken(decodeSafe(pair.slice(eq + 1)), literal, change.variable)}`;
      })
      .join("&");
  }
  if (change.location === "cookie") {
    const headers = { ...((next.headers as Record<string, string> | undefined) ?? {}) };
    const key = Object.keys(headers).find((item) => item.toLowerCase() === "cookie");
    if (key && typeof headers[key] === "string") {
      headers[key] = headers[key]
        .split(";")
        .map((part) => {
          const eq = part.indexOf("=");
          if (eq < 0 || part.slice(0, eq).trim() !== change.locationDetail) return part;
          return `${part.slice(0, eq)}=${replaceToken(part.slice(eq + 1).trim(), literal, change.variable)}`;
        })
        .join(";");
      next.headers = headers;
    }
  }
  if (change.location === "body") {
    next.body = patchBody(next.body, change.locationDetail, literal, change.variable);
  }
  return next;
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Replace the literal in the URL path and/or query, never in the host. */
function replaceInUrl(url: string, literal: string, variable: string, part: "path" | "query" | "all", queryKey?: string) {
  const pathStart = url.search(/[^/:]\/(?!\/)/);
  if (pathStart < 0) return part === "all" ? replaceToken(url, literal, variable) : url;
  const origin = url.slice(0, pathStart + 1);
  const rest = url.slice(pathStart + 1);
  const q = rest.indexOf("?");
  const path = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? "" : rest.slice(q + 1);
  const nextPath = part === "query" ? path : replaceToken(path, literal, variable);
  const nextQuery =
    part === "path"
      ? query
      : query
          .split("&")
          .map((pair) => {
            const eq = pair.indexOf("=");
            if (eq < 0 || (queryKey && decodeSafe(pair.slice(0, eq)) !== queryKey)) return pair;
            return `${pair.slice(0, eq)}=${replaceToken(decodeSafe(pair.slice(eq + 1)), literal, variable)}`;
          })
          .join("&");
  return `${origin}${nextPath}${query || q >= 0 ? `?${nextQuery}` : ""}`;
}

function patchBody(value: unknown, detail: string, literal: string, variable: string): unknown {
  const parts = detail.replace(/^body\.?/, "").split(".").filter(Boolean);
  if (parts.length === 0) {
    return typeof value === "string" ? replaceToken(value, literal, variable) : value;
  }
  if (!value || typeof value !== "object") return value;
  const clone = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  let cursor: unknown = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index] ?? "";
    if (!cursor || typeof cursor !== "object") return clone;
    const record = cursor as Record<string, unknown>;
    const child = record[key];
    record[key] =
      Array.isArray(child) ? [...child] : child && typeof child === "object" ? { ...child } : child;
    cursor = record[key];
  }
  const leaf = parts[parts.length - 1] ?? "";
  if (cursor && typeof cursor === "object") {
    const record = cursor as Record<string, unknown>;
    const current = record[leaf];
    if (typeof current === "string" || typeof current === "number") {
      record[leaf] = replaceToken(String(current), literal, variable);
    }
  }
  return clone;
}
