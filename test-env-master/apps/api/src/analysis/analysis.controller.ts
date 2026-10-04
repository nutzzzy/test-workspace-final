import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
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

  /** Start a background deep analysis (model-assisted) in the given language. */
  @Post(":jiraIssueId/deep")
  startDeep(
    @Param("jiraIssueId") jiraIssueId: string,
    @Body() body: { locale?: string; force?: boolean },
  ) {
    return this.analysisService.startDeepAnalysis(jiraIssueId, body?.locale, body?.force === true);
  }

  @Get(":jiraIssueId/deep")
  deepStatus(@Param("jiraIssueId") jiraIssueId: string, @Query("locale") locale?: string) {
    return this.analysisService.deepStatus(jiraIssueId, locale);
  }

  /** Why the edge-case list is empty for this requirement (read-only). */
  @Get(":jiraIssueId/edge-cases/explanation")
  edgeExplanation(@Param("jiraIssueId") jiraIssueId: string, @Query("locale") locale?: string) {
    return this.analysisService.explainEdgeCases(jiraIssueId, locale);
  }

  @Post(":jiraIssueId/deep/cancel")
  cancelDeep(@Param("jiraIssueId") jiraIssueId: string) {
    return this.analysisService.cancelDeepAnalysis(jiraIssueId);
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
