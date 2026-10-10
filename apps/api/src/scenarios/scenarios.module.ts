import { Module } from "@nestjs/common";
import { AIModule } from "../ai/ai.module";
import { DatabaseConnectorsModule } from "../database-connectors/database-connectors.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { ScenarioRunner } from "../scenario-engine/scenario.runner";
import { UiRecorderService } from "../scenario-engine/ui/ui-recorder.service";
import { UiSessionStore } from "../scenario-engine/ui/saved-sessions";
import { MobileRecorderService } from "../scenario-engine/mobile/mobile-recorder.service";
import { MobileRecordingsController } from "./mobile-recordings.controller";
import { UiSessionsController } from "./ui-sessions.controller";
import { ScenariosController } from "./scenarios.controller";
import { ScenariosService } from "./scenarios.service";
import { PreconditionExportController } from "./export/precondition-export.controller";
import { PreconditionExportService } from "./export/precondition-export.service";

@Module({
  imports: [EnvironmentsModule, DatabaseConnectorsModule, AIModule],
  controllers: [ScenariosController, MobileRecordingsController, UiSessionsController, PreconditionExportController],
  providers: [ScenariosService, ScenarioRunner, UiRecorderService, MobileRecorderService, UiSessionStore, PreconditionExportService],
  exports: [ScenariosService, ScenarioRunner],
})
export class ScenariosModule {}
