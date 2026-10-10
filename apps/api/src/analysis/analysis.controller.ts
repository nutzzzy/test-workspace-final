import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { AnalysisService, type AnalysisScope } from "./analysis.service";
import { MAX_DOCUMENT_BYTES } from "./studio/documents";

/** Legacy routes (one per tab) start a background run of that scope. */
const LEGACY: Record<string, AnalysisScope> = {
  requirements: "requirements",
  strategy: "strategy",
  "test-cases": "testCases",
  "edge-cases": "edgeCases",
  risks: "risks",
  automation: "automation",
  all: "all",
};

@Controller("analysis")
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  // ── runs ──

  /** Start a background analysis: scope (all, requirements, …), locale, optional acceptanceKeys. */
  @Post(":jiraIssueId/run")
  run(@Param("jiraIssueId") id: string, @Body() body: { scope?: string; locale?: string; acceptanceKeys?: string[] }) {
    return this.analysis.start(id, body ?? {});
  }

  @Get(":jiraIssueId/run")
  status(@Param("jiraIssueId") id: string, @Query("locale") locale?: string) {
    return this.analysis.status(id, locale);
  }

  @Post(":jiraIssueId/run/cancel")
  cancel(@Param("jiraIssueId") id: string) {
    return this.analysis.cancel(id);
  }

  @Get(":jiraIssueId/edge-cases/explanation")
  edgeExplanation(@Param("jiraIssueId") id: string, @Query("locale") locale?: string) {
    return this.analysis.explainEdgeCases(id, locale);
  }

  @Post(":jiraIssueId/localize")
  localize(@Param("jiraIssueId") id: string, @Body() body: { locale?: string }) {
    return this.analysis.localizeIssueForRequest(id, body?.locale);
  }

  // ── documents (PRD) ──

  @Get(":jiraIssueId/documents")
  documents(@Param("jiraIssueId") id: string) {
    return this.analysis.listDocuments(id);
  }

  @Post(":jiraIssueId/documents")
  addDocument(@Param("jiraIssueId") id: string, @Body() body: { title?: string; text?: string; kind?: string }) {
    return this.analysis.addDocumentText(id, body ?? {});
  }

  @Post(":jiraIssueId/documents/upload")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES } }))
  upload(@Param("jiraIssueId") id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: { title?: string; kind?: string }) {
    return this.analysis.uploadDocument(id, file, body ?? {});
  }

  @Get("documents/:docId")
  document(@Param("docId") docId: string) {
    return this.analysis.getDocument(docId);
  }

  @Delete("documents/:docId")
  deleteDocument(@Param("docId") docId: string) {
    return this.analysis.deleteDocument(docId);
  }

  // ── editing ──

  @Post(":jiraIssueId/criteria")
  addCriterion(@Param("jiraIssueId") id: string, @Body() body: { text?: string }) {
    return this.analysis.addCriterion(id, body ?? {});
  }

  @Patch("criteria/:criterionId")
  updateCriterion(@Param("criterionId") criterionId: string, @Body() body: { text?: string; confirm?: boolean }) {
    return this.analysis.updateCriterion(criterionId, body ?? {});
  }

  @Delete("criteria/:criterionId")
  deleteCriterion(@Param("criterionId") criterionId: string) {
    return this.analysis.deleteCriterion(criterionId);
  }

  @Patch(":jiraIssueId/requirements")
  updateAnalysis(@Param("jiraIssueId") id: string, @Body() body: Record<string, unknown>) {
    return this.analysis.updateAnalysis(id, body ?? {});
  }

  @Patch(":jiraIssueId/strategy")
  updateStrategy(@Param("jiraIssueId") id: string, @Body() body: Record<string, unknown>) {
    return this.analysis.updateStrategy(id, body ?? {});
  }

  @Post(":jiraIssueId/edge-cases/manual")
  addEdgeCase(@Param("jiraIssueId") id: string, @Body() body: { title?: string; description?: string }) {
    return this.analysis.addEdgeCase(id, body ?? {});
  }

  @Patch("edge-cases/:edgeId")
  updateEdgeCase(@Param("edgeId") edgeId: string, @Body() body: Record<string, unknown>) {
    return this.analysis.updateEdgeCase(edgeId, body ?? {});
  }

  @Delete("edge-cases/:edgeId")
  deleteEdgeCase(@Param("edgeId") edgeId: string) {
    return this.analysis.deleteEdgeCase(edgeId);
  }

  @Post("edge-cases/:edgeId/test-case")
  edgeToCase(@Param("edgeId") edgeId: string) {
    return this.analysis.edgeCaseToTestCase(edgeId);
  }

  @Patch("risks/:riskId")
  updateRisk(@Param("riskId") riskId: string, @Body() body: Record<string, unknown>) {
    return this.analysis.updateRisk(riskId, body ?? {});
  }

  @Delete("risks/:riskId")
  deleteRisk(@Param("riskId") riskId: string) {
    return this.analysis.deleteRisk(riskId);
  }

  @Patch("automation/:candidateId")
  updateAutomation(@Param("candidateId") candidateId: string, @Body() body: Record<string, unknown>) {
    return this.analysis.updateAutomation(candidateId, body ?? {});
  }

  @Delete("automation/:candidateId")
  deleteAutomation(@Param("candidateId") candidateId: string) {
    return this.analysis.deleteAutomation(candidateId);
  }

  /** Older clients and scripts: POST /analysis/:id/<tab> starts a run of that tab's scope. */
  @Post(":jiraIssueId/:legacy")
  legacy(
    @Param("jiraIssueId") id: string,
    @Param("legacy") legacy: string,
    @Body() body: { locale?: string; acceptanceKeys?: string[] },
  ) {
    return this.analysis.start(id, { scope: LEGACY[legacy] ?? "all", locale: body?.locale, acceptanceKeys: body?.acceptanceKeys });
  }
}
