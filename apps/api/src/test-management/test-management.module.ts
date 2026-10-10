import { Module } from "@nestjs/common";
import { LearningModule } from "../analysis/studio/learning.module";
import { TestManagementController } from "./test-management.controller";
import { TestManagementService } from "./test-management.service";

@Module({
  imports: [LearningModule],
  controllers: [TestManagementController],
  providers: [TestManagementService],
  exports: [TestManagementService],
})
export class TestManagementModule {}
