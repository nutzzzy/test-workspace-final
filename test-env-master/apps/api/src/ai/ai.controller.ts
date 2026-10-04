import { Body, Controller, Get, Post, Put } from "@nestjs/common";
import { AIService } from "./ai.service";

@Controller("ai")
export class AiController {
  constructor(private readonly ai: AIService) {}

  @Get("settings")
  settings() {
    return this.ai.getSettings();
  }

  @Put("settings")
  save(
    @Body()
    body: {
      provider?: string;
      baseUrl?: string;
      model?: string;
      temperature?: number;
      timeoutMs?: number;
      apiKey?: string;
      clearApiKey?: boolean;
      allowExternal?: boolean;
      deepAnalysis?: boolean;
    },
  ) {
    return this.ai.saveSettings(body ?? {});
  }

  @Get("settings/models")
  models() {
    return this.ai.listModels();
  }

  @Post("settings/test")
  test() {
    return this.ai.testConnection();
  }
}
