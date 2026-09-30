import { Module } from "@nestjs/common";
import { DatabaseConnectorsController } from "./database-connectors.controller";
import { DatabaseConnectorsService } from "./database-connectors.service";

@Module({
  controllers: [DatabaseConnectorsController],
  providers: [DatabaseConnectorsService],
  exports: [DatabaseConnectorsService],
})
export class DatabaseConnectorsModule {}
