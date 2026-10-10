import { Module } from "@nestjs/common";
import { AIModule } from "../ai/ai.module";
import { AnalysisController } from "./analysis.controller";
import { AnalysisService } from "./analysis.service";
import { LearningModule } from "./studio/learning.module";

@Module({
  imports: [AIModule, LearningModule],
  controllers: [AnalysisController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
