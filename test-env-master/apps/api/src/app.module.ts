import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AnalysisModule } from "./analysis/analysis.module";
import { AttachmentsModule } from "./attachments/attachments.module";
import { AIModule } from "./ai/ai.module";
import { BugsModule } from "./bugs/bugs.module";
import { DatabaseConnectorsModule } from "./database-connectors/database-connectors.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { EnvironmentsModule } from "./environments/environments.module";
import { HealthModule } from "./health/health.module";
import { JiraModule } from "./jira/jira.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { ScenariosModule } from "./scenarios/scenarios.module";
import { TestManagementModule } from "./test-management/test-management.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env"],
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    JiraModule,
    AIModule,
    AnalysisModule,
    TestManagementModule,
    AttachmentsModule,
    BugsModule,
    DashboardModule,
    EnvironmentsModule,
    DatabaseConnectorsModule,
    ScenariosModule,
  ],
})
export class AppModule {}
