import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { z } from "zod";
import { TestManagementService } from "./test-management.service";

const CreateCaseSchema = z.object({
  jiraIssueId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  preconditions: z.array(z.string()).optional(),
  steps: z.array(z.string()).min(1),
  expectedResult: z.string().min(1),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
  type: z.string().optional(),
  acceptanceKey: z.string().optional(),
});

const LEVEL = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const TEXT_LIST = z.array(z.string().max(4000)).max(200);

/**
 * Only user-editable content fields. Workflow fields (designStatus,
 * jiraSyncStatus, jiraSyncHash, jiraIssueId, …) are owned by the server and
 * are rejected here instead of being written straight into the row.
 */
export const UpdateCaseSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(10000),
    preconditions: TEXT_LIST,
    steps: TEXT_LIST.min(1),
    stepExpectations: TEXT_LIST,
    testData: TEXT_LIST,
    expectedResult: z.string().trim().min(1).max(10000),
    priority: LEVEL,
    type: z.string().trim().min(1).max(40),
    tags: z.array(z.string().max(80)).max(50),
    automationStatus: z.enum(["NOT_AUTOMATED", "AUTOMATED"]),
  })
  .partial()
  .strict();

const RecordRunSchema = z.object({
  testCaseId: z.string().min(1),
  status: z.string().min(1),
  notes: z.string().max(10000).optional(),
  evidence: z.string().max(10000).optional(),
});

const CreateSuiteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: z.string().optional(),
  testCaseIds: z.array(z.string().min(1)).max(1000).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Unknown keys (e.g. server-owned fields) are reported by name too.
    const field =
      issue?.path.join(".") ||
      (issue && "keys" in issue && Array.isArray(issue.keys) ? issue.keys.join(", ") : "");
    throw new BadRequestException(field ? `${message}: ${field}` : message);
  }
  return parsed.data;
}

@Controller()
export class TestManagementController {
  constructor(private readonly service: TestManagementService) {}

  @Get("test-cases")
  listCases(@Query("jiraIssueId") jiraIssueId?: string) {
    return this.service.listCases(jiraIssueId);
  }

  @Post("test-cases")
  createCase(@Body() body: unknown) {
    const parsed = CreateCaseSchema.safeParse(body);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join(".");
      throw new BadRequestException(field ? `Invalid test case field: ${field}` : "Invalid test case");
    }
    return this.service.createCase(parsed.data);
  }

  @Get("test-cases/:id")
  getCase(@Param("id") id: string) {
    return this.service.getCase(id);
  }

  @Patch("test-cases/:id")
  updateCase(@Param("id") id: string, @Body() body: unknown) {
    return this.service.updateCase(id, parseBody(UpdateCaseSchema, body, "Invalid test case field"));
  }

  @Delete("test-cases/:id")
  deleteCase(@Param("id") id: string) {
    return this.service.deleteCase(id);
  }

  @Post("test-cases/:id/approve")
  approveCase(@Param("id") id: string) {
    return this.service.approveCase(id);
  }

  @Patch("test-cases/:id/execution")
  saveExecution(
    @Param("id") id: string,
    @Body() body: { notes?: string; evidence?: string },
  ) {
    return this.service.saveExecution(id, {
      notes: typeof body.notes === "string" ? body.notes : undefined,
      evidence: typeof body.evidence === "string" ? body.evidence : undefined,
    });
  }

  @Post("test-runs")
  recordRun(@Body() body: unknown) {
    return this.service.recordRun(parseBody(RecordRunSchema, body, "Invalid test run"));
  }

  @Get("test-runs")
  listRuns(@Query("testCaseId") testCaseId?: string) {
    return this.service.listRuns(testCaseId);
  }

  @Get("test-suites")
  listSuites() {
    return this.service.listSuites();
  }

  @Get("test-suites/:id")
  getSuite(@Param("id") id: string) {
    return this.service.getSuite(id);
  }

  @Post("test-suites")
  createSuite(@Body() body: unknown) {
    return this.service.createSuite(parseBody(CreateSuiteSchema, body, "Invalid suite"));
  }

  @Delete("test-suites/:id")
  deleteSuite(@Param("id") id: string) {
    return this.service.deleteSuite(id);
  }

  @Post("test-suites/:id/cases")
  addCase(
    @Param("id") id: string,
    @Body() body: { testCaseId?: unknown },
  ) {
    if (typeof body?.testCaseId !== "string" || !body.testCaseId) {
      throw new BadRequestException("Select at least one test case");
    }
    return this.service.addCaseToSuite(id, body.testCaseId);
  }

  @Delete("test-suites/:id/cases/:testCaseId")
  removeCase(
    @Param("id") id: string,
    @Param("testCaseId") testCaseId: string,
  ) {
    return this.service.removeCaseFromSuite(id, testCaseId);
  }

  @Get("traceability/:jiraIssueId")
  traceability(@Param("jiraIssueId") jiraIssueId: string) {
    return this.service.getTraceability(jiraIssueId);
  }
}
