import { createHash } from "crypto";

export type SyncableTestCase = {
  id: string;
  title: string;
  description?: string | null;
  preconditions: unknown;
  steps: unknown;
  stepExpectations: unknown;
  testData: unknown;
  expectedResult: string;
  priority: string;
  type: string;
};

export function asLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && "action" in item) {
        const action = (item as { action?: unknown }).action;
        return typeof action === "string" ? action.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
}

export function testCaseContentHash(input: SyncableTestCase): string {
  const body = JSON.stringify({
    title: input.title.trim(),
    description: (input.description ?? "").trim(),
    preconditions: asLines(input.preconditions),
    steps: asLines(input.steps),
    stepExpectations: asLines(input.stepExpectations),
    testData: asLines(input.testData),
    expectedResult: input.expectedResult.trim(),
    priority: input.priority,
    type: input.type,
  });
  return createHash("sha256").update(body).digest("hex");
}

type AdfNode = Record<string, unknown>;

function text(value: string, marks?: Array<{ type: string }>): AdfNode {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraph(value: string): AdfNode {
  return { type: "paragraph", content: [text(value)] };
}

function heading(level: number, value: string): AdfNode {
  return { type: "heading", attrs: { level }, content: [text(value)] };
}

function bullet(items: string[]): AdfNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: [paragraph(item)],
    })),
  };
}

function numbered(items: Array<{ step: string; expected?: string }>): AdfNode {
  return {
    type: "orderedList",
    content: items.map((item) => ({
      type: "listItem",
      content: [
        paragraph(item.step),
        ...(item.expected ? [paragraph(`Expected result: ${item.expected}`)] : []),
      ],
    })),
  };
}

/** Readable Jira document. Not a JSON dump of the test case. */
export function testCaseDocument(input: SyncableTestCase): AdfNode {
  const preconditions = asLines(input.preconditions);
  const steps = asLines(input.steps);
  const expectations = asLines(input.stepExpectations);
  const data = asLines(input.testData);
  const content: AdfNode[] = [
    heading(3, `${input.id} — ${input.title}`),
    paragraph(`Priority: ${input.priority} · Type: ${input.type}`),
  ];
  if (input.description?.trim()) {
    content.push(paragraph(input.description.trim()));
  }
  if (preconditions.length > 0) {
    content.push(paragraph("Preconditions"));
    content.push(bullet(preconditions));
  }
  if (data.length > 0) {
    content.push(paragraph("Test data"));
    content.push(bullet(data));
  }
  content.push(paragraph("Steps"));
  content.push(
    numbered(
      steps.map((step, index) => ({
        step,
        expected: expectations[index],
      })),
    ),
  );
  content.push(paragraph(`Final expected result: ${input.expectedResult}`));
  content.push(paragraph("Synced from QA Workbench"));
  return { type: "doc", version: 1, content };
}

export function noteDocument(lines: string[]): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: lines.filter(Boolean).map((line) => paragraph(line)),
  };
}
