import { Module } from "@nestjs/common";
import { AIModule } from "../ai/ai.module";
import { DatabaseConnectorsModule } from "../database-connectors/database-connectors.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { ScenarioRunner } from "../scenario-engine/scenario.runner";
import { UiRecorderService } from "../scenario-engine/ui/ui-recorder.service";
import { ScenariosController } from "./scenarios.controller";
import { ScenariosService } from "./scenarios.service";

@Module({
  imports: [EnvironmentsModule, DatabaseConnectorsModule, AIModule],
  controllers: [ScenariosController],
  providers: [ScenariosService, ScenarioRunner, UiRecorderService],
  exports: [ScenariosService, ScenarioRunner],
})
export class ScenariosModule {}
