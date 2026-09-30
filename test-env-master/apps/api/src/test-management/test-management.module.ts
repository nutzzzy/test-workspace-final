import { Module } from "@nestjs/common";
import { TestManagementController } from "./test-management.controller";
import { TestManagementService } from "./test-management.service";

@Module({
  controllers: [TestManagementController],
  providers: [TestManagementService],
  exports: [TestManagementService],
})
export class TestManagementModule {}
