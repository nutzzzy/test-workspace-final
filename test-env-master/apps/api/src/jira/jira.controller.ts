import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { memoryStorage } from "multer";
import { JiraService } from "./jira.service";

@Controller("jira")
export class JiraController {
  constructor(private readonly jiraService: JiraService) {}

  @Get("config")
  getConfig() {
    return this.jiraService.getConfigPublic();
  }

  @Put("config")
  upsertConfig(
    @Body()
    body: {
      baseUrl: string;
      email: string;
      apiToken: string;
      projectKey?: string;
    },
  ) {
    return this.jiraService.upsertConfig(body).then(() =>
      this.jiraService.getConfigPublic(),
    );
  }

  @Get("issues")
  listIssues() {
    return this.jiraService.listIssues();
  }

  @Get("issues/:idOrKey")
  getIssue(@Param("idOrKey") idOrKey: string) {
    return this.jiraService.getIssue(idOrKey);
  }

  @Patch("issues/:id")
  updateIssue(
    @Param("id") id: string,
    @Body()
    body: {
      key: string;
      title: string;
      description?: string;
      priority?: string;
      acceptanceCriteria?: string[];
    },
  ) {
    return this.jiraService.updateIssue(id, body);
  }

  @Delete("issues/:id")
  deleteIssue(@Param("id") id: string) {
    return this.jiraService.deleteIssue(id);
  }

  @Post("issues/:id/test-cases/sync")
  syncTestCases(
    @Param("id") id: string,
    @Body() body: { testCaseIds?: string[] },
  ) {
    const ids = Array.isArray(body?.testCaseIds) ? body.testCaseIds : undefined;
    return this.jiraService.syncTestCases(id, ids);
  }

  @Post("import")
  importIssue(@Body() body: { key: string }) {
    return this.jiraService.importIssue(body.key);
  }

  @Post("manual")
  createManual(
    @Body()
    body: {
      key: string;
      title: string;
      description?: string;
      issueType?: string;
      priority?: string;
      labels?: string[];
      acceptanceCriteria?: string[];
    },
  ) {
    return this.jiraService.createManualIssue(body);
  }

  @Post("import-file")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  importFile(@UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        "Upload a .xlsx or .csv file in form field `file`",
      );
    }
    return this.jiraService.importFromSpreadsheet(
      file.buffer,
      file.originalname || "upload.xlsx",
    );
  }

  @Get("import-template")
  template(
    @Query("format") format: "csv" | "xlsx" = "xlsx",
    @Res() res: Response,
  ) {
    const safeFormat = format === "csv" ? "csv" : "xlsx";
    const buffer = this.jiraService.buildTemplateBuffer(safeFormat);
    const filename = `qa-issue-import-template.${safeFormat}`;
    res.setHeader(
      "Content-Type",
      safeFormat === "csv"
        ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Post("demo-import")
  demoImport() {
    return this.jiraService.createManualIssue({
      key: "QA-DEMO",
      title: "کاربر بتواند سفارش را لغو کند",
      description:
        "به عنوان مشتری می‌خواهم سفارشم را لغو کنم تا برای غذایی که دیگر نیاز ندارم هزینه پرداخت نکنم.",
      issueType: "Story",
      priority: "High",
      labels: ["orders", "payments"],
      acceptanceCriteria: [
        "کاربر احراز هویت‌شده بتواند سفارش در وضعیت CREATED یا CONFIRMED را لغو کند",
        "در صورت ثبت پرداخت، لغو سفارش باید منجر به استرداد وجه شود",
        "کاربر تأییدیه لغو را دریافت کند",
      ],
    });
  }
}
