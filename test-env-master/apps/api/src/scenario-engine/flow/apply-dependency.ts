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
  if (change.location === "url" && typeof next.url === "string") {
    next.url = replaceToken(next.url, literal, change.variable);
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
    }
  }
  if (change.location === "body") {
    next.body = patchBody(next.body, change.locationDetail, literal, change.variable);
  }
  return next;
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
