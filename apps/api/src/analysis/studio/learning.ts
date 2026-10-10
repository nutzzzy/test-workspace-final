import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AIService } from "../../ai/ai.service";
import { maskDeep } from "../../common/mask.util";
import { PrismaService } from "../../prisma/prisma.service";
import type { GuidanceScope } from "./pipeline";
import { distillPrompt, SYSTEM } from "./prompts";
import { DistillSchema } from "./schemas";

/**
 * How the analysis learns from the user, explicitly and reversibly:
 * - every edit, deletion, confirmation or rejection of generated content is
 *   recorded as feedback (credentials masked);
 * - the most recent corrections of a kind are shown to the model as examples
 *   the next time it writes that kind of artifact;
 * - feedback is distilled by a model into short guidelines, which the user
 *   can read, edit, switch off or delete in Settings. Guidelines the user
 *   writes are never changed by distillation.
 */

export type Artifact = "criterion" | "question" | "testCase" | "edgeCase" | "risk" | "strategy" | "automation" | "summary" | "gap";
export type FeedbackAction = "edit" | "delete" | "accept" | "reject" | "add";

const SCOPE_ARTIFACTS: Record<GuidanceScope, Artifact[]> = {
  criteria: ["criterion"],
  questions: ["question", "gap"],
  testCases: ["testCase"],
  edgeCases: ["edgeCase"],
  risks: ["risk"],
  strategy: ["strategy"],
  automation: ["automation"],
  summary: ["summary"],
};
const SCOPES = ["all", "criteria", "questions", "testCases", "edgeCases", "risks", "strategy", "automation", "summary"];

/** Distil after this many new corrections. */
const DISTIL_AFTER = 5;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 1200;
const MAX_GUIDANCE_CHARS = 3500;

function clip(value: unknown) {
  const text = JSON.stringify(value ?? null);
  return text.length > MAX_EXAMPLE_CHARS ? `${text.slice(0, MAX_EXAMPLE_CHARS)}…` : text;
}

@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);
  private distilling: Promise<unknown> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIService,
  ) {}

  /** Record a correction; distillation runs in the background once enough have accumulated. */
  async record(input: { artifact: Artifact; action: FeedbackAction; jiraIssueId?: string | null; locale?: string; before?: unknown; after?: unknown }) {
    await this.prisma.aiFeedback.create({
      data: {
        artifact: input.artifact,
        action: input.action,
        jiraIssueId: input.jiraIssueId ?? null,
        locale: input.locale ?? "en",
        before: input.before === undefined ? undefined : (maskDeep(input.before) as Prisma.InputJsonValue),
        after: input.after === undefined ? undefined : (maskDeep(input.after) as Prisma.InputJsonValue),
      },
    });
    const pending = await this.prisma.aiFeedback.count({ where: { learned: false } });
    if (pending >= DISTIL_AFTER && !this.distilling) {
      void this.distill().catch((error: unknown) => this.logger.warn(`Learning failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** Guidelines and recent correction examples for one stage, as a prompt block. */
  async guidance(): Promise<(scope: GuidanceScope) => string> {
    const [guidelines, feedback] = await Promise.all([
      this.prisma.aiGuideline.findMany({ where: { enabled: true }, orderBy: [{ source: "asc" }, { createdAt: "asc" }] }),
      this.prisma.aiFeedback.findMany({ where: { action: { in: ["edit", "delete", "reject"] } }, orderBy: { createdAt: "desc" }, take: 60 }),
    ]);
    return (scope) => {
      const rules = guidelines.filter((item) => item.scope === "all" || item.scope === scope).map((item) => `- ${item.text}`);
      const examples = feedback
        .filter((item) => SCOPE_ARTIFACTS[scope].includes(item.artifact as Artifact))
        .slice(0, MAX_EXAMPLES)
        .map((item) =>
          item.action === "edit"
            ? `BEFORE: ${clip(item.before)}\nAFTER (what the team wanted): ${clip(item.after)}`
            : `REMOVED BY THE TEAM (avoid items like this): ${clip(item.before)}`,
        );
      const parts = [
        rules.length ? `TEAM GUIDELINES (learned from this team — follow them; they take precedence over defaults):\n${rules.join("\n")}` : "",
        examples.length ? `RECENT CORRECTIONS BY THIS TEAM (apply the same preferences):\n${examples.join("\n\n")}` : "",
      ].filter(Boolean);
      return parts.join("\n\n").slice(0, MAX_GUIDANCE_CHARS);
    };
  }

  /** Turn accumulated feedback into guidelines (replaces earlier learned ones; manual ones stay). */
  distill() {
    if (this.distilling) return this.distilling;
    this.distilling = (async () => {
      const feedback = await this.prisma.aiFeedback.findMany({ orderBy: { createdAt: "desc" }, take: 60 });
      if (feedback.length === 0) return { guidelines: 0 };
      const learned = await this.prisma.aiGuideline.findMany({ where: { source: "learned" } });
      const examples = feedback
        .map((item) => `[${item.id}] ${item.artifact} · ${item.action}\nbefore: ${clip(item.before)}\nafter: ${clip(item.after)}`)
        .join("\n\n");
      const existing = learned.map((item) => `- (${item.scope}) ${item.text}`).join("\n") || "(none)";
      const { data } = await this.ai.call("learning", { system: SYSTEM, prompt: distillPrompt(examples, existing), schema: DistillSchema });
      const ids = new Set(feedback.map((item) => item.id));
      await this.prisma.$transaction([
        this.prisma.aiGuideline.deleteMany({ where: { source: "learned" } }),
        ...data.guidelines
          .filter((item) => item.text.length > 5)
          .map((item) =>
            this.prisma.aiGuideline.create({
              data: { scope: item.scope, text: item.text, source: "learned", feedbackIds: item.basedOn.filter((id) => ids.has(id)) },
            }),
          ),
        this.prisma.aiFeedback.updateMany({ where: { id: { in: [...ids] } }, data: { learned: true } }),
      ]);
      return { guidelines: data.guidelines.length };
    })().finally(() => {
      this.distilling = null;
    });
    return this.distilling;
  }

  async overview() {
    const [guidelines, feedback, pending] = await Promise.all([
      this.prisma.aiGuideline.findMany({ orderBy: [{ source: "asc" }, { createdAt: "asc" }] }),
      this.prisma.aiFeedback.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.aiFeedback.count({ where: { learned: false } }),
    ]);
    return { guidelines, feedback, pending, distilling: Boolean(this.distilling) };
  }

  async addGuideline(input: { scope?: string; text?: string }) {
    const text = String(input.text ?? "").trim();
    if (!text || text.length > 600) throw new BadRequestException("Write the guideline (up to 600 characters)");
    const scope = SCOPES.includes(String(input.scope)) ? String(input.scope) : "all";
    return this.prisma.aiGuideline.create({ data: { scope, text, source: "manual" } });
  }

  /** Editing a learned guideline makes it the user's own: distillation will not replace it. */
  async updateGuideline(id: string, input: { scope?: string; text?: string; enabled?: boolean }) {
    const current = await this.prisma.aiGuideline.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("Guideline not found");
    const text = input.text === undefined ? current.text : String(input.text).trim();
    if (!text || text.length > 600) throw new BadRequestException("Write the guideline (up to 600 characters)");
    return this.prisma.aiGuideline.update({
      where: { id },
      data: {
        text,
        scope: input.scope && SCOPES.includes(input.scope) ? input.scope : current.scope,
        enabled: input.enabled ?? current.enabled,
        source: input.text !== undefined && text !== current.text ? "manual" : current.source,
      },
    });
  }

  async deleteGuideline(id: string) {
    await this.prisma.aiGuideline.delete({ where: { id } }).catch(() => {
      throw new NotFoundException("Guideline not found");
    });
    return { ok: true };
  }

  /** Forget recorded corrections (and optionally what was learned from them). */
  async forget(input: { feedback?: boolean; learned?: boolean }) {
    if (input.feedback) await this.prisma.aiFeedback.deleteMany({});
    if (input.learned) await this.prisma.aiGuideline.deleteMany({ where: { source: "learned" } });
    return this.overview();
  }
}
