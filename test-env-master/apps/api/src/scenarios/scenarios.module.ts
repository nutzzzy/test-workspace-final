import { Module } from "@nestjs/common";
import { AIModule } from "../ai/ai.module";
import { DatabaseConnectorsModule } from "../database-connectors/database-connectors.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { ScenarioRunner } from "../scenario-engine/scenario.runner";
import { UiRecorderService } from "../scenario-engine/ui/ui-recorder.service";
import { UiSessionStore } from "../scenario-engine/ui/saved-sessions";
import { UiSessionsController } from "./ui-sessions.controller";
import { ScenariosController } from "./scenarios.controller";
import { ScenariosService } from "./scenarios.service";

@Module({
  imports: [EnvironmentsModule, DatabaseConnectorsModule, AIModule],
  controllers: [ScenariosController, UiSessionsController],
  providers: [ScenariosService, ScenarioRunner, UiRecorderService, UiSessionStore],
  exports: [ScenariosService, ScenarioRunner],
})
export class ScenariosModule {}
