import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { PreconditionExportService, type ExportRequest } from "./precondition-export.service";

/** Export a precondition, or one of its steps, as automation code (Playwright, Selenium, Cypress, Appium, …). Reads the precondition; never changes it. */
@Controller("scenarios/:id/export")
export class PreconditionExportController {
  constructor(private readonly exports: PreconditionExportService) {}

  /** Frameworks with their languages and file names, and the workspace's AI connections; `stepId` for one step's export. */
  @Get()
  options(@Param("id") id: string, @Query("stepId") stepId?: string) {
    return this.exports.options(id, typeof stepId === "string" && stepId ? stepId : undefined);
  }

  /** Generate the code with one AI request: the whole precondition, or one step (`stepId`). */
  @Post()
  generate(@Param("id") id: string, @Body() body: ExportRequest) {
    return this.exports.generate(id, body ?? {});
  }
}
