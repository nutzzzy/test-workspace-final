import { Module } from "@nestjs/common";
import { JiraModule } from "../jira/jira.module";
import { BugsController } from "./bugs.controller";
import { BugsService } from "./bugs.service";

@Module({
  imports: [JiraModule],
  controllers: [BugsController],
  providers: [BugsService],
})
export class BugsModule {}
