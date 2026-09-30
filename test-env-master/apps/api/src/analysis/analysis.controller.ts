import { Body, Controller, Param, Post } from "@nestjs/common";
import { AnalysisService } from "./analysis.service";

@Controller("analysis")
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Post(":jiraIssueId/requirements")
  analyze(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string },
  ) {
    return this.analysisService.exclusive(jiraIssueId, () =>
      this.analysisService.analyzeRequirements(jiraIssueId, body?.locale),
    );
  }

  @Post(":jiraIssueId/strategy")
  strategy(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string },
  ) {
    return this.analysisService.exclusive(jiraIssueId, () =>
      this.analysisService.generateStrategy(jiraIssueId, body?.locale),
    );
  }

  @Post(":jiraIssueId/test-cases")
  testCases(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string; mode?: string; acceptanceKeys?: string[] },
  ) {
    return this.analysisService.exclusive(jiraIssueId, () =>
      this.analysisService.generateTestCases(
        jiraIssueId,
        body?.locale,
        body?.mode,
        body?.acceptanceKeys,
      ),
    );
  }

  @Post(":jiraIssueId/edge-cases")
  edgeCases(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string },
  ) {
    return this.analysisService.exclusive(jiraIssueId, () =>
      this.analysisService.generateEdgeCases(jiraIssueId, body?.locale),
    );
  }

  @Post(":jiraIssueId/risks")
  risks(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string },
  ) {
    return this.analysisService.exclusive(jiraIssueId, () =>
      this.analysisService.generateRisks(jiraIssueId, body?.locale),
    );
  }

  @Post(":jiraIssueId/automation")
  automation(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string },
  ) {
    return this.analysisService.exclusive(jiraIssueId, () =>
      this.analysisService.generateAutomation(jiraIssueId, body?.locale),
    );
  }

  @Post(":jiraIssueId/all")
  all(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string },
  ) {
    return this.analysisService.exclusive(jiraIssueId, () =>
      this.analysisService.generateAll(jiraIssueId, body?.locale),
    );
  }

  @Post(":jiraIssueId/localize")
  localize(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string },
  ) {
    return this.analysisService.localizeIssueForRequest(
      jiraIssueId,
      body?.locale,
    );
  }
}
