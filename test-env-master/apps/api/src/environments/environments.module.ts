import { Module } from "@nestjs/common";
import { EnvironmentsController } from "./environments.controller";
import { EnvironmentsService } from "./environments.service";

@Module({
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
