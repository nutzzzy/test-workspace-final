import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { PreconditionExportService, type ExportRequest } from "./precondition-export.service";

/** Export a precondition as automation code (Playwright, Selenium, Cypress, …). Reads the precondition; never changes it. */
@Controller("scenarios/:id/export")
export class PreconditionExportController {
  constructor(private readonly exports: PreconditionExportService) {}

  /** Frameworks with their languages and file names, and the workspace's AI connections. */
  @Get()
  options(@Param("id") id: string) {
    return this.exports.options(id);
  }

  /** Generate the code with one AI request. */
  @Post()
  generate(@Param("id") id: string, @Body() body: ExportRequest) {
    return this.exports.generate(id, body ?? {});
  }
}
