import { Module } from "@nestjs/common";
import { AiController } from "./ai.controller";
import { AIService } from "./ai.service";

@Module({
  controllers: [AiController],
  providers: [AIService],
  exports: [AIService],
})
export class AIModule {}
