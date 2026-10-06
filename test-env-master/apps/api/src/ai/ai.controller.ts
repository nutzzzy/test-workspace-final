import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { resolveQualityConfig } from "../analysis/studio/quality/config";
import { AIService, type ConnectionInput } from "./ai.service";

@Controller("ai")
export class AiController {
  constructor(private readonly ai: AIService) {}

  @Get("connections")
  connections() {
    return this.ai.listConnections();
  }

  @Post("connections")
  create(@Body() body: ConnectionInput) {
    return this.ai.createConnection(body ?? {});
  }

  @Patch("connections/:id")
  update(@Param("id") id: string, @Body() body: ConnectionInput) {
    return this.ai.updateConnection(id, body ?? {});
  }

  @Delete("connections/:id")
  remove(@Param("id") id: string) {
    return this.ai.deleteConnection(id);
  }

  @Get("connections/:id/models")
  models(@Param("id") id: string) {
    return this.ai.listModels(id);
  }

  @Post("connections/:id/test")
  test(@Param("id") id: string) {
    return this.ai.testConnection(id);
  }

  /** Download a model into a local Ollama server (background; poll GET for progress). */
  @Post("connections/:id/pull")
  pull(@Param("id") id: string, @Body() body: { model?: string }) {
    return this.ai.startPull(id, String(body?.model ?? ""));
  }

  @Get("connections/:id/pull")
  pullStatus(@Param("id") id: string) {
    return this.ai.pullStatus(id);
  }

  @Get("routing")
  routing() {
    return this.ai.getRouting();
  }

  @Put("routing")
  saveRouting(@Body() body: Record<string, unknown>) {
    return this.ai.saveRouting(body ?? {});
  }

  @Get("limits")
  limits() {
    return this.ai.getRunBudget();
  }

  @Put("limits")
  saveLimits(@Body() body: { runBudgetMs?: unknown; providerTimeoutMs?: unknown }) {
    return this.ai.saveRunBudget(body ?? {});
  }

  /** Test-case quality model: the effective settings (defaults + saved overrides). */
  @Get("quality")
  async quality() {
    const saved = await this.ai.getQualitySettings();
    return { ...resolveQualityConfig(saved), compareProviders: saved.compareProviders !== false };
  }

  @Put("quality")
  async saveQuality(@Body() body: Record<string, unknown>) {
    const saved = await this.ai.saveQualitySettings(body ?? {});
    return { ...resolveQualityConfig(saved), compareProviders: saved.compareProviders !== false };
  }

  @Get("status")
  status() {
    return this.ai.analysisStatus();
  }
}
