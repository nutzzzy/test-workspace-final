import { Module } from "@nestjs/common";
import { AIModule } from "../../ai/ai.module";
import { LearningController } from "./learning.controller";
import { LearningService } from "./learning";

@Module({
  imports: [AIModule],
  controllers: [LearningController],
  providers: [LearningService],
  exports: [LearningService],
})
export class LearningModule {}
