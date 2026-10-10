import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { LearningService } from "./learning";

/** What the analysis has learned from the team, and the team's own rules for it. */
@Controller("ai/learning")
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get()
  overview() {
    return this.learning.overview();
  }

  /** Distil the recorded corrections into guidelines now. */
  @Post("distill")
  async distill() {
    await this.learning.distill();
    return this.learning.overview();
  }

  @Post("guidelines")
  add(@Body() body: { scope?: string; text?: string }) {
    return this.learning.addGuideline(body ?? {});
  }

  @Patch("guidelines/:id")
  update(@Param("id") id: string, @Body() body: { scope?: string; text?: string; enabled?: boolean }) {
    return this.learning.updateGuideline(id, body ?? {});
  }

  @Delete("guidelines/:id")
  remove(@Param("id") id: string) {
    return this.learning.deleteGuideline(id);
  }

  @Post("forget")
  forget(@Body() body: { feedback?: boolean; learned?: boolean }) {
    return this.learning.forget(body ?? {});
  }
}
