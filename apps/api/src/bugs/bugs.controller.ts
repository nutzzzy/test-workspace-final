import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { BugsService } from "./bugs.service";

@Controller("bugs")
export class BugsController {
  constructor(private readonly bugsService: BugsService) {}

  @Get()
  list() {
    return this.bugsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.bugsService.get(id);
  }

  @Post()
  create(
    @Body()
    body: {
      title: string;
      description?: string;
      reproductionSteps?: string[];
      expectedResult?: string;
      actualResult?: string;
      severity?: string;
      priority?: string;
      environment?: string;
      evidence?: string;
      assignee?: string;
      reporter?: string;
      author?: string;
      jiraIssueId?: string;
      testCaseId?: string;
      testRunId?: string;
      scenarioRunId?: string;
    },
  ) {
    return this.bugsService.create(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body()
    body: {
      title?: string;
      description?: string;
      reproductionSteps?: string[];
      expectedResult?: string;
      actualResult?: string;
      severity?: string;
      priority?: string;
      environment?: string;
      evidence?: string;
      assignee?: string;
      reporter?: string;
      author?: string;
      jiraIssueId?: string;
      testCaseId?: string;
      testRunId?: string;
      scenarioRunId?: string;
    },
  ) {
    return this.bugsService.update(id, body);
  }

  @Post(":id/status")
  status(
    @Param("id") id: string,
    @Body() body: { status?: string; author?: string },
  ) {
    return this.bugsService.changeStatus(id, body.status ?? "", body.author);
  }

  @Post(":id/comments")
  comment(
    @Param("id") id: string,
    @Body() body: { content?: string; author?: string },
  ) {
    return this.bugsService.addComment(id, body);
  }

  @Post("from-run/:testRunId")
  fromRun(@Param("testRunId") testRunId: string) {
    return this.bugsService.createFromFailedRun(testRunId);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.bugsService.remove(id);
  }
}
