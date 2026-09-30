import { Module } from "@nestjs/common";
import { DatabaseConnectorsModule } from "../database-connectors/database-connectors.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { ScenarioRunner } from "../scenario-engine/scenario.runner";
import { ScenariosController } from "./scenarios.controller";
import { ScenariosService } from "./scenarios.service";

@Module({
  imports: [EnvironmentsModule, DatabaseConnectorsModule],
  controllers: [ScenariosController],
  providers: [ScenariosService, ScenarioRunner],
  exports: [ScenariosService, ScenarioRunner],
})
export class ScenariosModule {}
